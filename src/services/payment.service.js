const mongoose = require("mongoose");
const Order = require("../models/Order");
const PaymentWebhookLog = require("../models/PaymentWebhookLog");
const financialService = require("./financial.service");
const pricingService = require("./pricing.service");

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
exports.processPaymentWebhook = async ({ provider, externalTransactionId, orderId, amount, payload }) => {
  // 1. Idempotency Check: Prevent duplicate processing if already handled
  const existingLog = await PaymentWebhookLog.findOne({ externalTransactionId });
  if (existingLog && existingLog.status === "PROCESSED") {
    return { status: "ALREADY_PROCESSED", log: existingLog };
  }

  const session = await mongoose.startSession();
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

    // 3. Verify Amount
    if (order.totalAmount !== amount) {
      throw new Error(`Mismatched payment amount. Expected: ${order.totalAmount}, Received: ${amount}`);
    }

    // 4. Update Order Status
    order.paymentStatus = "PAID";
    order.orderStatus = "PROCESSING";
    await order.save({ session });

    // 5. Generate Pricing Snapshots & Lock Escrow Funds per Vendor Item
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

    // 6. Record or Update Idempotency Webhook Log
    const webhookLog = await PaymentWebhookLog.findOneAndUpdate(
      { externalTransactionId },
      {
        provider,
        externalTransactionId,
        internalOrderId: order._id,
        status: "PROCESSED",
        amount,
        rawPayload: payload,
      },
      { upsert: true, new: true, session }
    );

    await session.commitTransaction();
    session.endSession();

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