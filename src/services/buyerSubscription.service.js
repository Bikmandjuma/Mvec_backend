// Buyer Premium (ad-free browsing): activated only by a successful payment.
const BuyerSubscription = require("../models/BuyerSubscription");
const notifications = require("./notification.service");

const PREMIUM = { price: 5000, days: 30 };
const DAY = 24 * 60 * 60 * 1000;

/**
 * Switch Premium on (or extend it by 30 days) for a paid payment. Safe to call
 * more than once for the same payment: the payment id is remembered.
 */
async function activatePremium({ userId, paymentId }) {
  let sub = await BuyerSubscription.findOne({ buyer: userId });
  if (sub && sub.lastPaymentId && String(sub.lastPaymentId) === String(paymentId)) return sub;
  if (!sub) sub = new BuyerSubscription({ buyer: userId });

  const now = new Date();
  const stillActive = sub.plan === "PREMIUM" && sub.status === "ACTIVE" && sub.renewalDate && new Date(sub.renewalDate) > now;
  const from = stillActive ? new Date(sub.renewalDate) : now;
  sub.plan = "PREMIUM";
  sub.status = "ACTIVE";
  sub.price = PREMIUM.price;
  sub.billingCycle = "MONTHLY";
  if (!stillActive) sub.startDate = now;
  sub.renewalDate = new Date(from.getTime() + PREMIUM.days * DAY);
  sub.lastPaymentId = String(paymentId);
  await sub.save();

  await notifications.premiumActivated(userId, sub.renewalDate).catch(() => {});
  return sub;
}

module.exports = { PREMIUM, activatePremium };
