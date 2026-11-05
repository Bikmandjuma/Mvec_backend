const orm = require("../database/orm");
const Order = require("../models/Order");
const Payment = require("../models/Payment");
const PaymentWebhookLog = require("../models/PaymentWebhookLog");
const financialService = require("./financial.service");
const pricingService = require("./pricing.service");
const socketService = require("./socket.service");
const affiliateAttribution = require("./affiliateAttribution.service");

/**
 * Record a webhook callback that was intentionally ignored (e.g. non-successful
 * status). Persisting it under the external id keeps our idempotency semantics
 * clear and avoids it ever being confused with a successful transaction.
 */
exports.recordIgnoredWebhook = async ({ provider, externalTransactionId, amount = 0, payload = {} }) => {
  if (!externalTransactionId) return null;
  try {
    return await PaymentWebhookLog.create({
      provider,
      externalTransactionId,
      internalOrderId: null,
      status: "IGNORED",
      amount: Number(amount) || 0,
      currency: "RWF",
      rawPayload: payload,
      errorMessage: "Transaction status not SUCCESSFUL. Ignored.",
    });
  } catch (err) {
    // Duplicate idempotency record — safe to swallow.
    return null;
  }
};


/**
 * Process payment callback idempotently
 */
exports.processPaymentWebhook = async ({ provider, externalTransactionId, orderId, paymentId = null, amount, payload, gatewayFee = 0, paymentMethod = null }) => {
  // 1. Idempotency Check: Prevent duplicate processing if already handled
  const existingLog = await PaymentWebhookLog.findOne({ externalTransactionId });
  if (existingLog && existingLog.status === "PROCESSED") {
    return { status: "ALREADY_PROCESSED", log: existingLog };
  }

  const session = await orm.startSession();
  session.startTransaction();

  try {
    // 2. Fetch Order
    const order = await Order.findById(orderId).session(session);
    if (!order) {
      throw new Error(`Order #${orderId} not found.`);
    }

    if (order.paymentStatus === "PAID") {
      await session.abortTransaction();
      session.endSession();
      return { status: "ALREADY_PAID", order };
    }

    // A late payment on a cancelled/expired order must not revive it: its
    // stock has already been returned. The failure is logged below so an
    // admin can refund the buyer.
    if (order.orderStatus === "CANCELLED") {
      throw new Error(`Order #${orderId} was cancelled before this payment arrived. Refund required.`);
    }

    // 3. Verify Amount
    if (order.totalAmount !== amount) {
      throw new Error(`Mismatched payment amount. Expected: ${order.totalAmount}, Received: ${amount}`);
    }

    // 4. Update Order Status & Legacy Status Field
    order.paymentStatus = "PAID";
    order.orderStatus = "PROCESSING";
    if (paymentMethod) order.paymentMethod = paymentMethod;
    order.paidAt = new Date();
    if (!order.deliveryOtp) {
      order.deliveryOtp = require("crypto").randomInt(100000, 1000000).toString();
    }
    await order.save({ session });

    // 4b. Update Payment Record Status
    // Target the exact payment attempt when known; an order can have several.
    await Payment.findOneAndUpdate(
      paymentId ? { _id: paymentId } : { parentOrder: order._id },
      {
        status: "SUCCESS",
        gatewayReference: externalTransactionId,
        gatewayFee,
        paidAt: new Date(),
      },
      { session }
    );

    // 5. Generate Pricing Snapshots & Lock Escrow Funds per Vendor Item
    // The provider fee is charged once per payment: share it across the lines
    // by value so it is never counted more than once.
    const linesTotal = order.items.reduce((sum, it) => sum + (Number(it.price) || 0) * (Number(it.quantity) || 0), 0);
    let feeLeft = Math.round((Number(gatewayFee) || 0) * 100) / 100;
    const feeShares = order.items.map((it, i) => {
      const share = i === order.items.length - 1 ? feeLeft
        : Math.round(((Number(gatewayFee) || 0) * ((Number(it.price) || 0) * (Number(it.quantity) || 0)) / (linesTotal || 1)) * 100) / 100;
      feeLeft = Math.round((feeLeft - share) * 100) / 100;
      return share;
    });
    for (const [lineIndex, item] of order.items.entries()) {
      // Attribution is per order item: only promoted items earn a commission.
      const aff = affiliateAttribution.itemAffiliate(order, item);
      const hasAffiliate = !!aff;
      const affiliateUserId = hasAffiliate ? aff.user : null;

      const snapshot = await pricingService.createItemPricingSnapshot({
        orderId: order._id,
        item,
        session,
        hasAffiliate,
        gatewayFee: feeShares[lineIndex] || 0,
        // Seller's own affiliate rate, frozen on the item at checkout.
        vendorAffiliatePercent: hasAffiliate ? Number(item.affiliateVendorRate) || 0 : 0,
      });

      const settlement = await financialService.lockPaymentInEscrow({
        orderId: order._id,
        vendorId: item.vendor,
        grossAmount: snapshot.grossTotal,
        commissionAmount: snapshot.commissionAmount,
        session,
        split: snapshot,
        affiliateUserId,
        orderItemId: item._id,
      });

      await affiliateAttribution.recordConversion({ order, item, settlement, session });
    }

    // 5b. Delivery fees are held for the seller of each parcel, commission-free.
    for (const parcel of order.shippingBreakdown || []) {
      if (!parcel.vendor || !(parcel.fee > 0)) continue;
      await financialService.lockPaymentInEscrow({
        orderId: order._id,
        vendorId: parcel.vendor,
        grossAmount: parcel.fee,
        commissionAmount: 0,
        session,
      });
    }

    // 6. Record or Update Idempotency Webhook Log & Explicitly Clear Previous Errors
    const webhookLog = await PaymentWebhookLog.findOneAndUpdate(
      { externalTransactionId },
      {
        provider,
        externalTransactionId,
        internalOrderId: order._id,
        status: "PROCESSED",
        errorMessage: null, // Explicitly reset stale validation error from prior retries
        amount,
        rawPayload: payload,
      },
      { upsert: true, new: true, session }
    );

    await session.commitTransaction();
    session.endSession();

    // Tell the buyer's open payment page (and dashboards) straight away.
    socketService.emitOrderStatusUpdate(order);
    socketService.emitToRoom(`user:${order.user}`, "payment_confirmed", { orderId: order._id.toString() });
    await require("./notification.service").paymentConfirmed(order).catch((err) => console.error("Payment notification failed:", err.message));

    return { status: "SUCCESS", order, webhookLog };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();

    // Log failure record for auditing
    await PaymentWebhookLog.findOneAndUpdate(
      { externalTransactionId },
      {
        provider,
        externalTransactionId,
        internalOrderId: orderId,
        status: "FAILED",
        amount,
        rawPayload: payload,
        errorMessage: error.message,
      },
      { upsert: true }
    );

    throw error;
  }
};
/**
 * Apply a final Paypack result to a payment. Used by both the Paypack webhook
 * and the status-polling endpoint, so it must be safe to call more than once.
 *
 * Payments linked to an order go through processPaymentWebhook (escrow and
 * commission); standalone payments only change their own status.
 */
// Applies a gateway result (SUCCESSFUL / FAILED / PENDING) to a payment: order
// payments go through escrow, standalone payments are marked directly.
exports.settleGatewayPayment = async ({ payment, provider, status, amount, fee = 0, payload = {}, externalTransactionId = null }) => {
  if (status === "SUCCESSFUL") {
    if (payment.parentOrder) {
      return exports.processPaymentWebhook({
        provider,
        paymentMethod: payment.method === "CARD" ? "CARD" : null,
        externalTransactionId: externalTransactionId || payment.gatewayReference,
        orderId: payment.parentOrder,
        paymentId: payment._id,
        amount,
        payload,
        gatewayFee: fee,
      });
    }

    if (Number(amount) !== payment.amount) {
      throw new Error(`Mismatched payment amount. Expected: ${payment.amount}, Received: ${amount}`);
    }

    // Only a PENDING payment can transition, which makes repeated callbacks no-ops.
    const updated = await Payment.findOneAndUpdate(
      { _id: payment._id, status: "PENDING" },
      { status: "SUCCESS", paidAt: new Date(), gatewayFee: fee, gatewayResponse: payload, ...(externalTransactionId ? { gatewayReference: externalTransactionId } : {}) },
      { returnDocument: "after" }
    );
    if (updated) await exports.fulfilStandalonePayment(updated);
    return { status: updated ? "SUCCESS" : "ALREADY_PROCESSED", payment: updated };
  }

  if (status === "FAILED") {
    const updated = await Payment.findOneAndUpdate(
      { _id: payment._id, status: "PENDING" },
      { status: "FAILED", gatewayResponse: payload },
      { returnDocument: "after" }
    );
    return { status: updated ? "FAILED" : "ALREADY_PROCESSED", payment: updated };
  }

  return { status: "PENDING" };
};

// Deliver what a successful standalone payment paid for.
exports.fulfilStandalonePayment = async (payment) => {
  if (payment.purpose === "BUYER_PREMIUM" && payment.user) {
    await require("./buyerSubscription.service").activatePremium({ userId: payment.user, paymentId: payment._id });
  }
  // A vendor paid a wholesale order (reference WHS-<orderId>-…): lock it in escrow.
  if (payment.purpose === "WHOLESALE") {
    const orderId = String(payment.transactionReference || "").split("-")[1];
    await require("./wholesale.service").markWholesalePaid(orderId, payment);
  }
};

exports.settlePaypackPayment = (args) => exports.settleGatewayPayment({ ...args, provider: "PAYPACK" });

// The gateway client for a payment, or null when it cannot be asked for a status.
function gatewayFor(payment) {
  if (payment.gateway === "PAYPACK" && payment.gatewayReference) return require("./paypack.service");
  if (payment.gateway === "KPAY") return require("./kpay.service");
  if (payment.gateway === "FLUTTERWAVE") return require("./flutterwave.service");
  return null;
}

/**
 * Ask the payment provider what happened to a PENDING payment and apply the
 * answer (paid → escrow / fulfilment, failed → failed). This is what the
 * payment page does while the buyer waits, and what the background sweep does
 * when nobody is waiting, so a missed or rejected webhook never leaves a paid
 * payment unrecorded. Returns the provider status, or null when nothing was asked.
 *
 * skipSandbox: a gateway without credentials answers "SUCCESSFUL" to every
 * lookup, so background jobs must not ask it.
 */
exports.syncWithProvider = async (payment, { skipSandbox = false } = {}) => {
  if (!payment || payment.status !== "PENDING") return null;
  const gateway = gatewayFor(payment);
  if (!gateway || (skipSandbox && gateway.isSandbox())) return null;

  if (payment.gateway === "PAYPACK") {
    const result = await gateway.getTransactionStatus(payment.gatewayReference);
    await exports.settlePaypackPayment({
      payment, status: result.status, amount: result.amount ?? payment.amount, fee: result.fee || 0, payload: result.raw || {},
    });
    return result.status;
  }
  if (payment.gateway === "KPAY") {
    const result = await gateway.checkStatus(payment.transactionReference);
    await exports.settleGatewayPayment({
      payment, provider: "KPAY", status: result.status, amount: payment.amount,
      payload: result.raw || {}, externalTransactionId: result.tid || payment.gatewayReference,
    });
    return result.status;
  }
  const result = await gateway.verifyByReference(payment.transactionReference);
  if (result.status === "SUCCESSFUL" && result.currency && result.currency !== "RWF") {
    throw Object.assign(new Error("Card payment in an unexpected currency"), { statusCode: 409 });
  }
  await exports.settleGatewayPayment({
    payment, provider: "FLUTTERWAVE", status: result.status, amount: result.amount ?? payment.amount,
    fee: result.fee || 0, payload: result.raw || {}, externalTransactionId: result.id,
  });
  return result.status;
};

/**
 * Background sweep: settle payments still PENDING a few minutes after they
 * started, for orders, wholesale orders and subscriptions alike. Runs only
 * against gateways with real credentials.
 */
exports.syncPendingPayments = async ({ olderThanMs = 2 * 60 * 1000, withinMs = 72 * 60 * 60 * 1000, limit = 50 } = {}) => {
  const now = Date.now();
  const pending = await Payment.find({
    status: "PENDING",
    gateway: { $in: ["PAYPACK", "KPAY", "FLUTTERWAVE"] },
    createdAt: { $lte: new Date(now - olderThanMs), $gte: new Date(now - withinMs) },
  }).sort({ createdAt: 1 }).limit(limit);
  const done = { checked: 0, paid: 0, failed: 0, errors: 0 };
  for (const payment of pending) {
    try {
      const status = await exports.syncWithProvider(payment, { skipSandbox: true });
      if (status === null) continue;
      done.checked += 1;
      if (status === "SUCCESSFUL") done.paid += 1;
      if (status === "FAILED") done.failed += 1;
    } catch (error) {
      done.errors += 1;
      console.error(`[Payment Sync] ${payment.transactionReference}: ${error.message}`);
    }
  }
  return done;
};
