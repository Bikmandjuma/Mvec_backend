const mongoose = require("mongoose");
const Order = require("../models/Order");
const Payment = require("../models/Payment");
const PaymentWebhookLog = require("../models/PaymentWebhookLog");
const { formatRwandanPhone } = require("../utils/momo.util");
const pricingService = require("../services/pricing.service");
const financialService = require("../services/financial.service");

// 1. Initiate MoMo / Airtel Payment
exports.initiateMoMoPayment = async (req, res) => {
  try {
    const { orderId, phoneNumber } = req.body;

    const phoneInfo = formatRwandanPhone(phoneNumber);
    if (!phoneInfo) {
      return res.status(400).json({
        message: "Invalid Rwandan phone number. Must start with 078/079 (MTN) or 073/072 (Airtel).",
      });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found." });
    }

    if (order.paymentStatus === "PAID") {
      return res.status(400).json({ message: "Order is already paid." });
    }

    const paymentMethod = phoneInfo.provider === "MTN" ? "MOMO" : "AIRTEL";
    const transactionRef = `ORD-${order._id}-${Date.now()}`;

    // Create or update pending Payment record
    const payment = await Payment.create({
      parentOrder: order._id,
      transactionReference: transactionRef,
      method: paymentMethod,
      phoneNumber: phoneInfo.formattedNumber,
      provider: phoneInfo.provider,
      amount: order.totalAmount,
      currency: "RWF",
      status: "PENDING",
    });

    order.paymentMethod = paymentMethod;
    await order.save();

    return res.status(200).json({
      message: `Payment prompt initiated for ${paymentMethod} (${phoneInfo.localNumber}). Please approve the USSD prompt on your phone.`,
      paymentRef: transactionRef,
      paymentId: payment._id,
      amount: order.totalAmount,
    });
  } catch (error) {
    return res.status(500).json({ message: "Payment initiation failed", error: error.message });
  }
};

// 2. Idempotent Webhook Handler with Escrow & Dynamic Commissioning
exports.handlePaymentWebhook = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const event = req.body;
    
    // Paystack / MoMo Provider standard payload parsing
    const reference = event.data?.reference || event.reference;
    const amount = event.data?.amount || event.amount;
    const isSuccessful = event.event === "charge.success" || event.status === "SUCCESSFUL";

    if (!isSuccessful) {
      await session.abortTransaction();
      session.endSession();
      return res.status(200).json({ status: "ignored", message: "Transaction not successful" });
    }

    // 1. Idempotency Check: Avoid processing duplicate webhook callbacks
    const existingLog = await PaymentWebhookLog.findOne({ externalTransactionId: reference }).session(session);
    if (existingLog && existingLog.status === "PROCESSED") {
      await session.abortTransaction();
      session.endSession();
      return res.status(200).json({ status: "success", message: "Already processed" });
    }

    // 2. Locate Payment & Order Records
    const payment = await Payment.findOne({ transactionReference: reference }).session(session);
    if (!payment) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: "Associated payment record not found." });
    }

    const order = await Order.findById(payment.parentOrder).session(session);
    if (!order) {
      await session.abortTransaction();
      session.endSession();
      return res.status(404).json({ message: "Associated order not found." });
    }

    // 3. Mark Payment & Order as PAID
    payment.status = "SUCCESS";
    payment.paidAt = new Date();
    payment.gatewayResponse = event;
    await payment.save({ session });

    order.paymentStatus = "PAID";
    order.orderStatus = "PROCESSING";
    await order.save({ session });

    // 4. Evaluate Dynamic Commission & Lock Escrow Funds per Vendor Item
    for (const item of order.items) {
      const snapshot = await pricingService.createItemPricingSnapshot({
        orderId: order._id,
        item,
        session,
      });

      await financialService.lockPaymentInEscrow({
        orderId: order._id,
        vendorId: item.vendor,
        grossAmount: snapshot.grossTotal,
        commissionAmount: snapshot.commissionAmount,
        session,
      });
    }

    // 5. Create Idempotency Audit Log Entry
    await PaymentWebhookLog.create(
      [
        {
          provider: payment.provider === "MTN" ? "MTN_MOMO" : "AIRTEL_MONEY",
          externalTransactionId: reference,
          internalOrderId: order._id,
          status: "PROCESSED",
          amount: payment.amount,
          rawPayload: event,
        },
      ],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json({ status: "success", message: "Payment processed & escrow locked." });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({ message: "Webhook processing error", error: error.message });
  }
};