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
    user: order.user,
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
    throw Object.assign(new Error("We could not reach the mobile money network, so no prompt was sent and no money was taken. Please try again in a moment."), {
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

/**
 * Standalone payment: a signed-in user pays a chosen amount that is not tied
 * to an order (used by the mobile app for top-ups and manual collections).
 * Orders are always paid with an orderId so the server sets the amount.
 */
async function initiateStandalonePayment({ amount, phoneNumber, userId, gatewayService, explicitProvider = null }) {
  const value = Number(amount);
  if (!Number.isInteger(value) || value <= 0) {
    throw Object.assign(new Error("Enter an amount in whole Rwandan francs, for example 1000."), { statusCode: 400 });
  }
  if (gatewayService.isSandbox() && process.env.NODE_ENV === "production") {
    throw Object.assign(new Error("Mobile money payments are temporarily unavailable. Please try again later."), { statusCode: 503 });
  }
  const phoneInfo = formatRwandanPhone(phoneNumber);
  if (!phoneInfo) {
    throw Object.assign(new Error("Enter an MTN (078/079) or Airtel (072/073) mobile money number."), { statusCode: 400 });
  }
  if (explicitProvider && phoneInfo.provider !== explicitProvider) {
    throw Object.assign(new Error(`That is ${phoneInfo.provider === "MTN" ? "an MTN" : "an Airtel"} number. Use ${explicitProvider === "MTN" ? "an MTN" : "an Airtel"} number for this payment method.`), { statusCode: 400 });
  }
  const provider = explicitProvider || phoneInfo.provider;
  const paymentMethod = provider === "MTN" ? "MOMO" : "AIRTEL";
  const transactionRef = `PAY-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  const payment = await Payment.create({
    user: userId,
    transactionReference: transactionRef,
    method: paymentMethod,
    phoneNumber: phoneInfo.formattedNumber,
    provider,
    amount: value,
    currency: "RWF",
    status: "PENDING",
    gateway: gatewayService.name,
    gatewayResponse: { phase: "initiated" },
  });

  try {
    const push = await gatewayService.triggerUssdPush({ amount: value, currency: "RWF", phone: phoneInfo.formattedNumber });
    if (push.reference) payment.gatewayReference = push.reference;
    if (push.raw) payment.gatewayResponse = push.raw;
  } catch (pushError) {
    payment.gatewayResponse = { error: pushError.message };
    payment.status = "FAILED";
    await payment.save();
    throw Object.assign(new Error("We could not reach the mobile money network, so no prompt was sent and no money was taken. Please try again in a moment."), { statusCode: 502 });
  }
  // Without gateway credentials (development) the payment is simulated.
  if (gatewayService.isSandbox()) {
    payment.status = "SUCCESS";
    payment.paidAt = new Date();
  }
  await payment.save();

  return {
    message: `Payment prompt sent to ${phoneInfo.localNumber}. Please approve it on your phone.`,
    paymentRef: transactionRef,
    paymentId: payment._id,
    amount: value,
    gatewayReference: payment.gatewayReference || null,
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
      const { orderId, amount, phoneNumber } = req.body;
      const userId = req.user.id || req.user._id.toString();
      let result;
      if (orderId) {
        result = await initiateMobileMoneyPayment({ orderId, phoneNumber, gatewayService: paypackGateway, explicitProvider, reqUserId: userId });
      } else if (amount !== undefined) {
        result = await initiateStandalonePayment({ amount, phoneNumber, userId, gatewayService: paypackGateway, explicitProvider });
      } else {
        return res.status(400).json({ message: "Send the orderId of the order you are paying for." });
      }
      return res.status(200).json(result);
    } catch (error) {
      if (!error.statusCode) {
        console.error("Mobile money payment failed:", error);
        return res.status(500).json({ message: "Something went wrong on our side while starting the payment. No money was taken. Please try again; if it keeps failing, contact MVEC support." });
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
    if (!payment) return res.status(404).json({ message: "Payment not found." });

    // Owner: the order's buyer for order payments, the payer for standalone ones.
    let ownerId = payment.user ? String(payment.user) : null;
    if (payment.parentOrder) {
      const paymentOrder = await Order.findById(payment.parentOrder).select("user");
      ownerId = paymentOrder ? String(paymentOrder.user) : null;
    }
    if (ownerId !== String(req.user.id) && req.user.role !== "super_admin") {
      return res.status(404).json({ message: "Payment not found." });
    }

    if (payment.status === "PENDING" && payment.gateway === "PAYPACK" && payment.gatewayReference) {
      const result = await paypackService.getTransactionStatus(payment.gatewayReference);
      await paymentService.settlePaypackPayment({
        payment,
        status: result.status,
        amount: result.amount ?? payment.amount,
        fee: result.fee || 0,
        payload: result.raw || {},
      });
    }

    const fresh = await Payment.findById(payment._id);
    const order = fresh.parentOrder
      ? await Order.findById(fresh.parentOrder).select("paymentStatus orderStatus totalAmount")
      : null;
    return res.status(200).json({ payment: fresh, order });
  } catch (error) {
    console.error("Payment status check failed:", error);
    return res.status(502).json({ message: "We could not check the payment with the mobile money network right now. Your payment is safe; try again in a minute." });
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
    if (!order.user || order.user.toString() !== req.user.id) {
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
