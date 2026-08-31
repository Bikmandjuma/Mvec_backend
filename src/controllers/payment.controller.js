// src/controllers/payment.controller.js
const Order = require("../models/Order");
const PayoutLedger = require("../models/Payout");
const Payment = require("../models/Payment");
const { formatRwandanPhone } = require("../utils/momo.util");

const COMMISSION_RATE = 0.10; // 10% Platform Fee

// 1. Initiate MoMo Payment
const initiateMoMoPayment = async (req, res) => {
  try {
    const { orderId, phoneNumber } = req.body;

    const phoneInfo = formatRwandanPhone(phoneNumber);
    if (!phoneInfo) {
      return res.status(400).json({
        message: "Invalid Rwandan phone number. Must start with 078/079 (MTN) or 073 (Airtel).",
      });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found." });
    }

    const paymentMethod = phoneInfo.provider === "MTN" ? "MOMO" : "AIRTEL";
    const transactionRef = `ORD-${order._id}-${Date.now()}`;

    // Create Payment Record
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

    // Update order status reference
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

// 2. Webhook Callback Handler
const handlePaymentWebhook = async (req, res) => {
  try {
    const event = req.body;

    if (event.event === "charge.success") {
      const { reference, amount } = event.data;

      // Find payment record by transaction reference
      const payment = await Payment.findOne({ transactionReference: reference });

      if (payment && payment.status !== "SUCCESS") {
        payment.status = "SUCCESS";
        payment.paidAt = new Date();
        payment.gatewayResponse = event.data;
        await payment.save();

        // Update corresponding Order status
        const order = await Order.findById(payment.parentOrder);
        if (order) {
          order.paymentStatus = "PAID";
          order.orderStatus = "CONFIRMED";
          await order.save();

          // Financial Split (10% Platform / 90% Vendor)
          const platformFee = Math.round(amount * COMMISSION_RATE);
          const vendorAmount = amount - platformFee;

          await PayoutLedger.create({
            vendor: order.vendor,
            order: order._id,
            grossAmount: amount,
            platformFee: platformFee,
            netAmount: vendorAmount,
            status: "PENDING",
          });
        }
      }
    }

    return res.status(200).json({ status: "success" });
  } catch (error) {
    return res.status(500).json({ message: "Webhook processing error", error: error.message });
  }
};

module.exports = {
  initiateMoMoPayment,
  handlePaymentWebhook,
};