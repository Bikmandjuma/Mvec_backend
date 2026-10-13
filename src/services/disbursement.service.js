// Sends refunds and affiliate withdrawals to mobile money through Paypack,
// confirms them from the provider callback (or by polling), and retries.
const Disbursement = require("../models/Disbursement");
const Order = require("../models/Order");
const AffiliatePayout = require("../models/AffiliatePayout");
const AffiliateWallet = require("../models/AffiliateWallet");
const paypackService = require("./paypack.service");
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
}

async function attempt(d) {
  d.attempts += 1;
  try {
    const result = await paypackService.sendMoney({ amount: d.amount, phone: d.phone });
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
  async queue({ kind, recipient, phone, amount, order = null, affiliatePayout = null, idempotencyKey }) {
    const existing = await Disbursement.findOne({ idempotencyKey });
    if (existing) return existing;
    const d = await Disbursement.create({ kind, recipient, phone, amount: Math.round(amount), order, affiliatePayout, idempotencyKey });
    return attempt(d);
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
    const due = await Disbursement.find({ status: { $in: ["SENT", "FAILED"] }, attempts: { $lt: MAX_ATTEMPTS + 1 }, nextAttemptAt: { $lte: new Date() } }).limit(50);
    for (const d of due) {
      if (d.status === "SENT" && d.gatewayReference) {
        try {
          const result = await paypackService.getTransactionStatus(d.gatewayReference);
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

  /** Admin: send a failed transfer again now. */
  async retryNow(id) {
    const d = await Disbursement.findById(id);
    if (!d) throw Object.assign(new Error("Transfer not found."), { statusCode: 404 });
    if (d.status === "SUCCESS") throw Object.assign(new Error("This transfer already succeeded."), { statusCode: 400 });
    if (d.kind === "AFFILIATE_PAYOUT" && d.attempts >= MAX_ATTEMPTS) {
      throw Object.assign(new Error("This withdrawal was returned to the affiliate's balance. Ask them to request it again."), { statusCode: 400 });
    }
    d.attempts = Math.min(d.attempts, MAX_ATTEMPTS - 1);
    return attempt(d);
  },
};
