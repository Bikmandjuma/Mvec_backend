const mongoose = require("mongoose");
const Order = require("../models/Order");
const Payment = require("../models/Payment");
const { formatRwandanPhone } = require("../utils/momo.util");
const paymentService = require("../services/payment.service");
const paypackService = require("../services/paypack.service");
const socketService = require("../services/socket.service");

async function initiateMobileMoneyPayment({ orderId, phoneNumber, gatewayService, explicitProvider = null }) {
  const phoneInfo = formatRwandanPhone(phoneNumber);
  if (!phoneInfo) {
    throw Object.assign(new Error("Invalid Rwandan phone number. Must start with 078/079 (MTN) or 073/072 (Airtel)."), { statusCode: 400 });
  }

  // For explicit provider endpoints (e.g. Airtel), enforce the matching prefix.
  if (explicitProvider && phoneInfo.provider !== explicitProvider) {
    throw Object.assign(
      new Error(`The phone number you entered is a ${phoneInfo.provider} number. Please use a ${explicitProvider} number for this payment method.`),
      { statusCode: 400 }
    );
  }

  const provider = explicitProvider || phoneInfo.provider;
  const paymentMethod = provider === "MTN" ? "MOMO" : "AIRTEL";

  const order = await Order.findById(orderId);
  if (!order) {
    throw Object.assign(new Error("Order not found."), { statusCode: 404 });
  }

  if (order.paymentStatus === "PAID") {
    throw Object.assign(new Error("Order is already paid."), { statusCode: 400 });
  }

  const transactionRef = `ORD-${order._id}-${Date.now()}`;

  // 1. Create a pending Payment record BEFORE pushing so the webhook can
  //    reconcile the callback against a persisted transaction.
  const payment = await Payment.create({
    parentOrder: order._id,
    transactionReference: transactionRef,
    method: paymentMethod,
    phoneNumber: phoneInfo.formattedNumber,
    provider,
    amount: order.totalAmount,
    currency: "RWF",
    status: "PENDING",
    gateway: gatewayService.name,
    gatewayResponse: { phase: "initiated" },
  });

  order.paymentMethod = paymentMethod;
  await order.save();

  // 2. Trigger the USSD push to the buyer's phone number.
  let gatewayReference = null;
  let pushStatus = "PENDING";
  try {
    const push = await gatewayService.triggerUssdPush({
      amount: order.totalAmount,
      currency: "RWF",
      phone: phoneInfo.formattedNumber,
    });
    gatewayReference = push.reference || null;
    if (push.raw) payment.gatewayResponse = push.raw;
    if (push.status) pushStatus = push.status;
  } catch (pushError) {
    payment.gatewayResponse = { error: pushError.message };
    payment.status = "FAILED";
    await payment.save();
    throw Object.assign(new Error("Unable to reach the mobile money gateway. Payment not pushed."), {
      statusCode: 502,
      details: pushError.message,
    });
  }

  // 3. Store the provider reference returned by the gateway.
  if (gatewayReference) {
    payment.gatewayReference = gatewayReference;
  }

  // If sandbox / dev environment, automatically mark as PAID so orders progress reliably
  if (gatewayService.isSandbox()) {
    payment.status = "SUCCESS";
    payment.paidAt = new Date();
    order.paymentStatus = "PAID";
    order.orderStatus = "CONFIRMED";
    if (!order.deliveryOtp) {
      order.deliveryOtp = Math.floor(100000 + Math.random() * 900000).toString();
    }
    await order.save();
    socketService.emitOrderStatusUpdate(order);
    socketService.emitToRoom(`order:${order._id}`, "order_paid", order);
  }

  await payment.save();

  return {
    message: `Payment prompt initiated for ${paymentMethod} (${phoneInfo.localNumber}). Please approve the USSD prompt on your phone.`,
    paymentRef: transactionRef,
    paymentId: payment._id,
    amount: order.totalAmount,
    gatewayReference,
    status: payment.status,
  };
}

// All mobile money collections go through Paypack, which handles both MTN and Airtel numbers.
const paypackGateway = {
  name: "PAYPACK",
  isSandbox: () => paypackService.isSandbox(),
  triggerUssdPush: (args) => paypackService.triggerUssdPush(args),
};

function mobileMoneyHandler(explicitProvider) {
  return async (req, res) => {
    try {
      const { orderId, phoneNumber } = req.body;
      const result = await initiateMobileMoneyPayment({
        orderId,
        phoneNumber,
        gatewayService: paypackGateway,
        explicitProvider,
      });
      return res.status(200).json(result);
    } catch (error) {
      const statusCode = error.statusCode || 500;
      return res.status(statusCode).json({ message: error.message, ...(error.details && { error: error.details }) });
    }
  };
}

// 1. Initiate a Paypack payment for any MTN or Airtel number (provider auto-detected)
exports.initiatePaypackPayment = mobileMoneyHandler(null);

// 1a. Initiate MTN MoMo USSD Push Payment (via Paypack)
exports.initiateMomoPayment = mobileMoneyHandler("MTN");

// 1b. Initiate Airtel Money USSD Push Payment (via Paypack)
exports.initiateAirtelPayment = mobileMoneyHandler("AIRTEL");

// 1c. Check a payment's status, reconciling with Paypack while it is still pending.
//     Lets clients poll for completion when the Paypack webhook cannot reach the
//     server (e.g. local development).
exports.checkPaymentStatus = async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.paymentId);
    if (!payment) {
      return res.status(404).json({ message: "Payment not found." });
    }

    if (payment.status === "PENDING" && payment.gateway === "PAYPACK" && payment.gatewayReference) {
      const result = await paypackService.getTransactionStatus(payment.gatewayReference);

      if (result.status === "SUCCESSFUL") {
        await paymentService.processPaymentWebhook({
          provider: "PAYPACK",
          externalTransactionId: payment.gatewayReference,
          orderId: payment.parentOrder,
          paymentId: payment._id,
          amount: result.amount ?? payment.amount,
          payload: result.raw || {},
          gatewayFee: result.fee || 0,
        });
      } else if (result.status === "FAILED") {
        payment.status = "FAILED";
        payment.gatewayResponse = result.raw || payment.gatewayResponse;
        await payment.save();
      }
    }

    const fresh = await Payment.findById(payment._id);
    const order = await Order.findById(fresh.parentOrder).select("paymentStatus orderStatus totalAmount");
    return res.status(200).json({ payment: fresh, order });
  } catch (error) {
    return res.status(500).json({ message: "Unable to check payment status", error: error.message });
  }
};

// Direct payment confirmation endpoint (for Card, Bank, or dev confirmation)
exports.confirmPayment = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { orderId, method = "CARD" } = req.body;

    const order = await Order.findById(orderId).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ message: "Order not found." });
    }

    order.paymentStatus = "PAID";
    order.orderStatus = "CONFIRMED";
    order.paymentMethod = method;
    if (!order.deliveryOtp) {
      order.deliveryOtp = Math.floor(100000 + Math.random() * 900000).toString();
    }
    await order.save({ session });

    await Payment.create(
      [
        {
          parentOrder: order._id,
          transactionReference: `TXN-${order._id}-${Date.now()}`,
          method,
          amount: order.totalAmount,
          currency: "RWF",
          status: "SUCCESS",
          paidAt: new Date(),
          gatewayResponse: { phase: "confirmed", direct: true },
        },
      ],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    socketService.emitOrderStatusUpdate(order);
    socketService.emitToRoom(`order:${order._id}`, "order_paid", order);

    return res.status(200).json({
      message: "Payment confirmed successfully",
      order,
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({ message: "Payment confirmation failed", error: error.message });
  }
};
