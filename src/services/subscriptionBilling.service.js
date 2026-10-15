// Vendor Premium billing: the monthly fee is paid from the seller's available
// balance (sales earnings). Cancelling stops auto-renew; Premium stays active
// until the paid period ends. renewDueSubscriptions() runs hourly (slaWorker).
const Subscription = require("../models/Subscription");
const { VendorBalance } = require("../models/Payout");
const sellerFinance = require("./sellerFinance.service");
const { notify } = sellerFinance;

const PREMIUM_PRICE = 15000;
const PERIOD_DAYS = 30;
const addDays = (d, n) => new Date(new Date(d).getTime() + n * 86400000);
const fmt = (n) => `${Number(n || 0).toLocaleString("en-RW")} RWF`;

const chargeBalance = (vendorId, amount, reference, description) =>
  sellerFinance.chargeBalance(vendorId, amount, { type: "SUBSCRIPTION", reference, description });

const isActivePremium = (sub) => sub && sub.plan === "PREMIUM" && sub.status === "ACTIVE" && sub.renewalDate && new Date(sub.renewalDate) > new Date();

// Start (or restart) Premium, paid from the balance.
async function startPremium(vendorId) {
  let sub = await Subscription.findOne({ vendor: vendorId });
  if (isActivePremium(sub)) {
    if (!sub.autoRenew) { sub.autoRenew = true; await sub.save(); return { sub, message: "Auto-renew is back on. Premium continues after this period." }; }
    return { sub, message: "Premium is already active." };
  }
  const balance = await VendorBalance.findOne({ vendor: vendorId });
  const now = new Date();
  const ref = `SUB-${now.getTime()}`;
  const charged = await chargeBalance(vendorId, PREMIUM_PRICE, ref, `Vendor Premium · ${now.toLocaleDateString("en-GB")} – ${addDays(now, PERIOD_DAYS).toLocaleDateString("en-GB")}`);
  if (!charged) {
    const error = new Error(`Premium costs ${fmt(PREMIUM_PRICE)} a month and is paid from your available balance (${fmt(balance?.availableBalance)}). It becomes available once enough sales are released to you.`);
    error.status = 402;
    throw error;
  }
  if (!sub) sub = new Subscription({ vendor: vendorId });
  sub.plan = "PREMIUM";
  sub.status = "ACTIVE";
  sub.price = PREMIUM_PRICE;
  sub.billingCycle = "MONTHLY";
  sub.autoRenew = true;
  sub.startDate = now;
  sub.renewalDate = addDays(now, PERIOD_DAYS);
  await sub.save();
  return { sub, message: `Vendor Premium activated. ${fmt(PREMIUM_PRICE)} was paid from your balance; next renewal ${sub.renewalDate.toLocaleDateString("en-GB")}.` };
}

// Stop auto-renew; Premium stays until the paid period ends.
async function cancelPremium(vendorId) {
  const sub = await Subscription.findOne({ vendor: vendorId });
  if (!isActivePremium(sub)) {
    if (sub && sub.plan !== "FREE") { await downgrade(sub); }
    return { sub, message: "You're on the Free plan." };
  }
  sub.autoRenew = false;
  await sub.save();
  return { sub, message: `Auto-renew is off. Premium stays active until ${new Date(sub.renewalDate).toLocaleDateString("en-GB")}, then you move to Free.` };
}

async function downgrade(sub) {
  sub.plan = "FREE";
  sub.status = "ACTIVE";
  sub.price = 0;
  sub.billingCycle = "FREE";
  sub.renewalDate = null;
  sub.autoRenew = false;
  await sub.save();
}

// Renew or end Premium subscriptions whose period is over.
async function renewDueSubscriptions(now = new Date()) {
  const due = await Subscription.find({ plan: "PREMIUM", status: "ACTIVE", renewalDate: { $lte: now } });
  const result = { renewed: 0, ended: 0 };
  for (const sub of due) {
    if (sub.autoRenew) {
      const from = new Date(sub.renewalDate);
      const charged = await chargeBalance(sub.vendor, sub.price || PREMIUM_PRICE, `SUB-${now.getTime()}-${String(sub._id).slice(-4)}`, `Vendor Premium renewal · ${from.toLocaleDateString("en-GB")} – ${addDays(from, PERIOD_DAYS).toLocaleDateString("en-GB")}`);
      if (charged) {
        sub.renewalDate = addDays(from > now ? from : now, PERIOD_DAYS);
        await sub.save();
        result.renewed += 1;
        await notify(sub.vendor, "Premium renewed", `${fmt(sub.price || PREMIUM_PRICE)} was paid from your balance. Next renewal ${sub.renewalDate.toLocaleDateString("en-GB")}.`);
        continue;
      }
      await notify(sub.vendor, "Premium ended", `Your balance didn't cover the ${fmt(sub.price || PREMIUM_PRICE)} renewal, so you're back on the Free plan. Upgrade again any time.`);
    } else {
      await notify(sub.vendor, "Premium ended", "Your Premium period ended and auto-renew was off. You're on the Free plan.");
    }
    await downgrade(sub);
    result.ended += 1;
  }
  return result;
}

module.exports = { PREMIUM_PRICE, startPremium, cancelPremium, renewDueSubscriptions, isActivePremium };
