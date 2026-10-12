const mongoose = require("mongoose");
const Order = require("../models/Order");
const Payment = require("../models/Payment");
const { formatRwandanPhone } = require("../utils/momo.util");
const paymentService = require("../services/payment.service");
const paypackService = require("../services/paypack.service");
const socketService = require("../services/socket.service");

const DUPLICATE_PUSH_WINDOW_MS = 2 * 60 * 1000;

async function initiateMobileMoneyPayment({ orderId, phoneNumber, gatewayService, explicitProvider = null, reqUserId }) {
  if (!mongoose.isValidObjectId(orderId)) {
    throw Object.assign(new Error("A valid order ID is required."), { statusCode: 400 });
  }

  // Without gateway credentials the gateway runs in simulation mode. That is
  // fine for local development but must never mark real orders as paid.
  if (gatewayService.isSandbox() && process.env.NODE_ENV === "production") {
    throw Object.assign(new Error("Mobile money payments are temporarily unavailable. Please try again later."), { statusCode: 503 });
  }

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
  if (!order || order.user.toString() !== reqUserId.toString()) {
    throw Object.assign(new Error("Order not found."), { statusCode: 404 });
  }
  if (order.paymentStatus === "PAID") {
    throw Object.assign(new Error("Order is already paid."), { statusCode: 400 });
  }
  if (order.orderStatus !== "PENDING") {
    throw Object.assign(new Error("This order can no longer be paid. Please place a new order."), { statusCode: 400 });
  }

  // One USSD prompt at a time: a double click must not charge the buyer twice.
  const recentPending = await Payment.findOne({
    parentOrder: order._id,
    status: "PENDING",
    createdAt: { $gte: new Date(Date.now() - DUPLICATE_PUSH_WINDOW_MS) },
  }).sort({ createdAt: -1 });
  if (recentPending) {
    throw Object.assign(
      new Error("A payment prompt was already sent to your phone. Approve it, or wait two minutes before trying again."),
      { statusCode: 409, paymentId: recentPending._id }
    );
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
  try {
    const push = await gatewayService.triggerUssdPush({
      amount: order.totalAmount,
      currency: "RWF",
      phone: phoneInfo.formattedNumber,
    });
    gatewayReference = push.reference || null;
    if (push.raw) payment.gatewayResponse = push.raw;
  } catch (pushError) {
    payment.gatewayResponse = { error: pushError.message };
    payment.status = "FAILED";
    await payment.save();
    throw Object.assign(new Error("Unable to reach the mobile money gateway. Payment not pushed."), {
      statusCode: 502,
    });
  }

  // 3. Store the provider reference returned by the gateway.
  if (gatewayReference) payment.gatewayReference = gatewayReference;
  await payment.save();

  // 4. Development simulation: confirm through the same path a real gateway
  //    callback uses, so escrow, settlements and the delivery code are created.
  if (gatewayService.isSandbox()) {
    await paymentService.processPaymentWebhook({
      provider: gatewayService.name,
      externalTransactionId: gatewayReference || transactionRef,
      orderId: order._id,
      paymentId: payment._id,
      amount: order.totalAmount,
      payload: { sandbox: true },
    });
  }

  const fresh = await Payment.findById(payment._id);
  return {
    message: `Payment prompt sent to ${phoneInfo.localNumber}. Please approve it on your phone.`,
    paymentRef: transactionRef,
    paymentId: payment._id,
    amount: order.totalAmount,
    gatewayReference,
    status: fresh.status,
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
        reqUserId: req.user.id || req.user._id.toString(),
      });
      return res.status(200).json(result);
    } catch (error) {
      if (!error.statusCode) {
        console.error("Mobile money payment failed:", error);
        return res.status(500).json({ message: "We could not start the payment. Please try again." });
      }
      return res.status(error.statusCode).json({ message: error.message, ...(error.paymentId && { paymentId: error.paymentId }) });
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
    if (!mongoose.isValidObjectId(req.params.paymentId)) {
      return res.status(400).json({ message: "Invalid payment ID." });
    }
    const payment = await Payment.findById(req.params.paymentId);
    if (!payment) {
      return res.status(404).json({ message: "Payment not found." });
    }
    const paymentOrder = await Order.findById(payment.parentOrder).select("user");
    if (!paymentOrder || paymentOrder.user.toString() !== req.user.id) {
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
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({ message: "Direct payment confirmation is disabled in production." });
  }
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { orderId, method = "CARD" } = req.body;
    if (!mongoose.isValidObjectId(orderId)) {
      await session.abortTransaction();
      return res.status(400).json({ message: "Invalid order ID." });
    }
    if (!["CARD", "BANK"].includes(method)) {
      await session.abortTransaction();
      return res.status(400).json({ message: "Direct confirmation only supports CARD or BANK." });
    }

    const order = await Order.findById(orderId).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ message: "Order not found." });
    }
    if (order.user.toString() !== req.user.id) {
      await session.abortTransaction();
      return res.status(404).json({ message: "Order not found." });
    }
    if (order.paymentStatus === "PAID") {
      await session.abortTransaction();
      return res.status(409).json({ message: "Order is already paid." });
    }

    order.paymentStatus = "PAID";
    order.orderStatus = "CONFIRMED";
    order.paidAt = new Date();
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
