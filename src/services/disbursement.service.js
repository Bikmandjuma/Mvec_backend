// Sends refunds and seller/affiliate withdrawals to mobile money through Paypack,
// confirms them from the provider callback (or by polling), and retries.
const Disbursement = require("../models/Disbursement");
const Order = require("../models/Order");
const AffiliatePayout = require("../models/AffiliatePayout");
const AffiliateWallet = require("../models/AffiliateWallet");
const VendorWallet = require("../models/VendorWallet");
const { Payout } = require("../models/Payout");
const paypackService = require("./paypack.service");
const flutterwaveService = require("./flutterwave.service");
const notifications = require("./notification.service");

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 10 * 60 * 1000;

async function onSuccess(d) {
  if (d.kind === "REFUND" && d.order) {
    const order = await Order.findById(d.order);
    if (order) await notifications.refundSent(order, d.amount);
  }
  if (d.kind === "AFFILIATE_PAYOUT" && d.affiliatePayout) {
    const payout = await AffiliatePayout.findOneAndUpdate(
      { _id: d.affiliatePayout, status: { $in: ["PROCESSING", "APPROVED", "PENDING"] } },
      { $set: { status: "COMPLETED", transactionReference: d.gatewayReference } },
      { new: true },
    );
    if (payout) {
      await AffiliateWallet.updateOne({ affiliateUser: payout.affiliateUser }, { $inc: { totalWithdrawn: payout.amount } });
      await notifications.affiliatePayout(payout.affiliateUser, { amount: payout.amount, status: "COMPLETED" });
    }
  }
  if (d.kind === "VENDOR_PAYOUT" && d.vendorPayout) {
    const payout = await Payout.findOneAndUpdate(
      { _id: d.vendorPayout, status: { $in: ["PENDING", "PROCESSING"] } },
      { $set: { status: "PAID", transferReference: d.gatewayReference, processedAt: new Date() } },
      { new: true },
    );
    if (payout) {
      await VendorWallet.updateOne({ vendor: payout.vendor }, { $inc: { totalWithdrawn: payout.amount } });
      await notifications.vendorPayout(payout.vendor, { amount: payout.amount, status: "PAID" }).catch(() => {});
    }
  }
}

async function onFinalFailure(d) {
  if (d.kind === "REFUND" && d.order) {
    const order = await Order.findById(d.order);
    if (order) await notifications.refundFailed(order, d.amount, d.lastError || "provider error");
  }
  if (d.kind === "AFFILIATE_PAYOUT" && d.affiliatePayout) {
    // Give the money back to the affiliate's available balance.
    const payout = await AffiliatePayout.findOneAndUpdate(
      { _id: d.affiliatePayout, status: { $in: ["PROCESSING", "APPROVED", "PENDING"] } },
      { $set: { status: "REJECTED", rejectionReason: "Mobile money transfer failed. The amount is back in your balance." } },
      { new: true },
    );
    if (payout) {
      await AffiliateWallet.updateOne({ affiliateUser: payout.affiliateUser }, { $inc: { availableBalance: payout.amount } });
      await notifications.affiliatePayout(payout.affiliateUser, { amount: payout.amount, status: "FAILED", reason: "The transfer failed and the amount is back in your balance. Check your number and try again." });
    }
  }
  if (d.kind === "VENDOR_PAYOUT" && d.vendorPayout) {
    // Give the money back to the seller's available balance.
    const payout = await Payout.findOneAndUpdate(
      { _id: d.vendorPayout, status: { $in: ["PENDING", "PROCESSING"] } },
      { $set: { status: "FAILED", rejectionReason: "The mobile money transfer failed. The amount is back in your balance." } },
      { new: true },
    );
    if (payout) {
      await VendorWallet.updateOne({ vendor: payout.vendor }, { $inc: { availableBalance: payout.amount } });
      await notifications.vendorPayout(payout.vendor, { amount: payout.amount, status: "FAILED" }).catch(() => {});
    }
  }
}

async function attempt(d) {
  if (d.channel === "MANUAL") return d; // an admin refunds it in the provider's portal
  d.attempts += 1;
  try {
    const result = d.channel === "CARD"
      ? await flutterwaveService.refund({ transactionId: d.cardTransactionId, amount: d.amount })
      : await paypackService.sendMoney({ amount: d.amount, phone: d.phone });
    d.gatewayReference = result.reference || d.gatewayReference;
    d.lastError = "";
    if (result.status === "SUCCESSFUL") {
      d.status = "SUCCESS";
      d.completedAt = new Date();
      await d.save();
      await onSuccess(d);
    } else if (result.status === "FAILED") {
      throw new Error("Provider reported the transfer as failed");
    } else {
      d.status = "SENT";
      d.nextAttemptAt = new Date(Date.now() + RETRY_DELAY_MS);
      await d.save();
    }
  } catch (err) {
    d.lastError = err.message.slice(0, 300);
    d.status = "FAILED";
    d.nextAttemptAt = new Date(Date.now() + RETRY_DELAY_MS);
    await d.save();
    if (d.attempts >= MAX_ATTEMPTS) await onFinalFailure(d);
  }
  return d;
}

module.exports = {
  /** Queue a transfer and try it straight away. Safe to call twice with the same key. */
  async queue({ kind, recipient, phone = null, amount, order = null, affiliatePayout = null, vendorPayout = null, idempotencyKey, channel = "MOMO", cardTransactionId = null }) {
    const existing = await Disbursement.findOne({ idempotencyKey });
    if (existing) return existing;
    const d = await Disbursement.create({ kind, channel, recipient, phone, cardTransactionId, amount: Math.round(amount), order, affiliatePayout, vendorPayout, idempotencyKey });
    return attempt(d);
  },

  /**
   * Give a buyer their money back the way they paid: card payments go back to
   * the card, mobile money to the number that paid (or the recipient's phone).
   * Returns the transfer, or null when there is nowhere to send it.
   */
  async refundPayment({ order, payment, amount, idempotencyKey }) {
    // K-Pay has no refund API: card/SPENN refunds are done by an admin in the K-Pay portal.
    if (payment?.gateway === "KPAY" && ["CARD", "SPENN"].includes(payment.method)) {
      const existing = await Disbursement.findOne({ idempotencyKey });
      if (existing) return existing;
      const d = await Disbursement.create({
        kind: "REFUND", channel: "MANUAL", recipient: order.user, cardTransactionId: payment.gatewayReference,
        amount: Math.round(amount), order: order._id, idempotencyKey, status: "QUEUED",
        lastError: `Refund ${Math.round(amount)} RWF in the K-Pay merchant portal (transaction ${payment.gatewayReference || payment.transactionReference}), then mark it done.`,
      });
      await notifications.manualRefundNeeded(order, d).catch(() => {});
      return d;
    }
    if (payment?.method === "CARD") {
      return module.exports.queue({
        kind: "REFUND", channel: "CARD", recipient: order.user, cardTransactionId: payment.gatewayReference,
        amount, order: order._id, idempotencyKey,
      });
    }
    const phone = payment?.phoneNumber || order.recipient?.phone;
    if (!phone) return null;
    return module.exports.queue({ kind: "REFUND", recipient: order.user, phone, amount, order: order._id, idempotencyKey });
  },

  /** Provider callback for a CASHOUT transaction. */
  async handleCallback({ ref, status }) {
    const d = await Disbursement.findOne({ gatewayReference: ref });
    if (!d || d.status === "SUCCESS") return d;
    if (status === "SUCCESSFUL") {
      d.status = "SUCCESS";
      d.completedAt = new Date();
      await d.save();
      await onSuccess(d);
    } else if (status === "FAILED") {
      d.status = "FAILED";
      d.lastError = "Provider reported the transfer as failed";
      await d.save();
      if (d.attempts >= MAX_ATTEMPTS) await onFinalFailure(d);
    }
    return d;
  },

  /** Worker: confirm SENT transfers and retry FAILED ones that are due. */
  async processDue() {
    const due = await Disbursement.find({ status: { $in: ["SENT", "FAILED"] }, channel: { $ne: "MANUAL" }, attempts: { $lt: MAX_ATTEMPTS + 1 }, nextAttemptAt: { $lte: new Date() } }).limit(50);
    for (const d of due) {
      if (d.status === "SENT" && d.gatewayReference) {
        try {
          const result = d.channel === "CARD"
            ? await flutterwaveService.refundStatus(d.gatewayReference)
            : await paypackService.getTransactionStatus(d.gatewayReference);
          await module.exports.handleCallback({ ref: d.gatewayReference, status: result.status });
          if (result.status === "PENDING") {
            d.nextAttemptAt = new Date(Date.now() + RETRY_DELAY_MS);
            await d.save();
          }
        } catch (err) {
          console.error("[Disbursement] status check failed:", err.message);
        }
      } else if (d.status === "FAILED" && d.attempts < MAX_ATTEMPTS) {
        await attempt(d);
      }
    }
  },

  /** Admin: confirm a manual refund was made in the provider's portal. */
  async markManualDone(id, adminNote = "") {
    const d = await Disbursement.findById(id);
    if (!d) throw Object.assign(new Error("Transfer not found."), { statusCode: 404 });
    if (d.channel !== "MANUAL") throw Object.assign(new Error("Only manual refunds are marked done by hand."), { statusCode: 400 });
    if (d.status === "SUCCESS") return d;
    d.status = "SUCCESS";
    d.completedAt = new Date();
    d.lastError = String(adminNote || "").slice(0, 300);
    await d.save();
    await onSuccess(d);
    return d;
  },

  /** Admin: send a failed transfer again now. */
  async retryNow(id) {
    const d = await Disbursement.findById(id);
    if (!d) throw Object.assign(new Error("Transfer not found."), { statusCode: 404 });
    if (d.status === "SUCCESS") throw Object.assign(new Error("This transfer already succeeded."), { statusCode: 400 });
    if (["AFFILIATE_PAYOUT", "VENDOR_PAYOUT"].includes(d.kind) && d.attempts >= MAX_ATTEMPTS) {
      throw Object.assign(new Error("This withdrawal was returned to the user's balance. Ask them to request it again."), { statusCode: 400 });
    }
    d.attempts = Math.min(d.attempts, MAX_ATTEMPTS - 1);
    return attempt(d);
  },
};
