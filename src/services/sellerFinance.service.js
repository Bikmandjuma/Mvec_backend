// Seller money picture: where each order's earnings stand (escrow, released,
// frozen by a dispute, refunded, or collected by the seller), plus the
// statement of sales, payouts, charges and dispute releases.
const Order = require("../models/Order");
const Settlement = require("../models/Settlement");
const Dispute = require("../models/Dispute");
const SellerCharge = require("../models/SellerCharge");
const Notification = require("../models/Notification");
const { Payout } = require("../models/Payout");
const { TOTAL_PLATFORM_FEE_PERCENT } = require("../config/revenueSplit");

const OPEN_DISPUTE = ["OPEN", "UNDER_REVIEW", "EVIDENCE_SUBMITTED"];
const DONE = ["DELIVERED", "COMPLETED"];
const CLOSED = ["CANCELLED", "REFUNDED", "RETURNED", "FAILED"];
const round = (n) => Math.round(Number(n) || 0);
const sellerCollects = (o) => o.source === "MANUAL" && (o.paidOffline || o.paymentMethod === "CASH_ON_DELIVERY");

// One line per order with this seller's share.
async function orderLines(vendorId) {
  const vid = String(vendorId);
  const orders = await Order.find({ "items.vendor": vid }).sort({ createdAt: -1 });
  if (!orders.length) return [];
  const ids = orders.map((o) => o._id);
  const [settlements, disputes] = await Promise.all([
    Settlement.find({ order: { $in: ids }, vendor: vid }),
    Dispute.find({ order: { $in: ids }, vendor: vid }),
  ]);
  const settlementsByOrder = new Map();
  settlements.forEach((s) => { const k = String(s.order); (settlementsByOrder.get(k) || settlementsByOrder.set(k, []).get(k)).push(s); });
  const disputeByOrder = new Map(disputes.map((d) => [String(d.order), d]));

  return orders.map((o) => {
    const items = (o.items || []).filter((i) => i.vendor && String(i.vendor) === vid);
    const subtotal = items.reduce((t, i) => t + Number(i.price) * Number(i.quantity) - Number(i.discount || 0), 0);
    const delivery = (o.shippingBreakdown || []).filter((p) => p.vendor && String(p.vendor) === vid).reduce((t, p) => t + Number(p.fee || 0), 0);
    const sets = settlementsByOrder.get(String(o._id)) || [];
    // Exact figures from escrow settlements when the order was paid through MVEC.
    const commission = sets.length ? sets.reduce((t, s) => t + Number(s.commissionAmount || 0), 0) : (subtotal * TOTAL_PLATFORM_FEE_PERCENT) / 100;
    const net = sets.length ? sets.reduce((t, s) => t + Number(s.netAmount || 0), 0) : subtotal - commission + delivery;
    const dispute = disputeByOrder.get(String(o._id));

    let state;
    if (sellerCollects(o)) state = CLOSED.includes(o.orderStatus) ? "CANCELLED" : "COLLECTED_BY_SELLER";
    else if (o.paymentStatus === "REFUNDED" || (CLOSED.includes(o.orderStatus) && o.paymentStatus !== "PAID")) state = o.paymentStatus === "REFUNDED" ? "REFUNDED" : "CANCELLED";
    else if (o.paymentStatus !== "PAID") state = "UNPAID";
    else if (dispute && OPEN_DISPUTE.includes(dispute.status)) state = "FROZEN";
    else if (dispute && dispute.status.startsWith("RESOLVED")) state = "ARBITRATED";
    else if (DONE.includes(o.orderStatus)) state = "RELEASED";
    else state = "IN_ESCROW";

    return {
      orderId: o._id, orderNumber: o.orderNumber, createdAt: o.createdAt, releasedAt: o.deliveredAt || null,
      orderStatus: o.orderStatus, paymentStatus: o.paymentStatus, source: o.source || "ONLINE",
      subtotal: round(subtotal), commission: round(commission), delivery: round(delivery), net: round(net), state,
      dispute: dispute ? { number: dispute.disputeNumber, status: dispute.status, released: round(dispute.arbitrationDecision?.vendorReleaseAmount || (dispute.status === "RESOLVED_VENDOR_RELEASED" ? dispute.disputedAmount : 0)) } : null,
    };
  });
}

async function summary(vendorId) {
  const [lines, payouts] = await Promise.all([orderLines(vendorId), Payout.find({ vendor: vendorId })]);
  const sum = (state) => lines.filter((l) => l.state === state).reduce((t, l) => t + l.net, 0);
  return {
    inEscrow: sum("IN_ESCROW"),
    frozen: sum("FROZEN"),
    collectedBySeller: lines.filter((l) => l.state === "COLLECTED_BY_SELLER").reduce((t, l) => t + l.subtotal + l.delivery, 0),
    pendingPayouts: payouts.filter((p) => ["PENDING", "PROCESSING"].includes(p.status)).reduce((t, p) => t + Number(p.amount), 0),
    paidOut: payouts.filter((p) => p.status === "PAID").reduce((t, p) => t + Number(p.amount), 0),
    commissionPaid: lines.filter((l) => ["RELEASED", "ARBITRATED"].includes(l.state)).reduce((t, l) => t + l.commission, 0),
    escrowOrders: lines.filter((l) => l.state === "IN_ESCROW").length,
    frozenOrders: lines.filter((l) => l.state === "FROZEN").length,
  };
}

// Statement entries, newest first. `effect` = change to the available balance.
async function statement(vendorId, { from, to } = {}) {
  const [lines, payouts, charges] = await Promise.all([
    orderLines(vendorId),
    Payout.find({ vendor: vendorId }).sort({ createdAt: -1 }),
    SellerCharge.find({ vendor: vendorId }).sort({ createdAt: -1 }),
  ]);
  const entries = [];
  for (const l of lines) {
    if (l.state === "UNPAID") continue;
    entries.push({
      type: "SALE", date: l.createdAt, reference: l.orderNumber, orderId: l.orderId, state: l.state, source: l.source,
      gross: l.subtotal + l.delivery, commission: l.commission, delivery: l.delivery, net: l.net,
      effect: l.state === "RELEASED" ? l.net : 0,
    });
    if (l.state === "ARBITRATED" && l.dispute?.released > 0) {
      entries.push({ type: "DISPUTE_RELEASE", date: l.createdAt, reference: l.dispute.number, orderId: l.orderId, state: "RELEASED", net: l.dispute.released, effect: l.dispute.released });
    }
  }
  for (const p of payouts) {
    entries.push({
      type: "PAYOUT", date: p.createdAt, reference: p.payoutNumber, state: p.status, net: -Number(p.amount),
      effect: ["REJECTED", "CANCELLED", "FAILED"].includes(p.status) ? 0 : -Number(p.amount),
      detail: [p.payoutDetails?.bankName, p.payoutDetails?.accountNumber].filter(Boolean).join(" · "),
      transferReference: p.transferReference || null, rejectionReason: p.rejectionReason || null,
    });
  }
  for (const c of charges) {
    entries.push({ type: c.type, date: c.createdAt, reference: c.reference, state: c.status, net: -Number(c.amount), effect: c.status === "CHARGED" ? -Number(c.amount) : 0, detail: c.description });
  }
  const f = from ? new Date(from) : null;
  const t = to ? new Date(new Date(to).getTime() + 86399999) : null;
  return entries
    .filter((e) => (!f || new Date(e.date) >= f) && (!t || new Date(e.date) <= t))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

async function notify(recipient, title, message, reference = "", type = "PAYOUT") {
  try { await Notification.create({ recipient, type, title, message, reference }); } catch (e) { /* notifications are best-effort */ }
}

// Takes `amount` from the seller's available balance atomically and records
// the charge. Returns null when the balance is too low.
async function chargeBalance(vendorId, amount, { type, reference, description }) {
  const VendorWallet = require("../models/VendorWallet");
  const charged = await VendorWallet.findOneAndUpdate(
    { vendor: vendorId, availableBalance: { $gte: amount } },
    { $inc: { availableBalance: -amount } },
    { new: true },
  );
  if (!charged) return null;
  await SellerCharge.create({ vendor: vendorId, type, amount, reference, description });
  const ledger = require("./ledger.service");
  if (type === "ADVERTISING") {
    // Reserved for the campaign; it becomes MVEC revenue click by click.
    await ledger.post({ from: ["VENDOR_PAYABLE", vendorId], to: ["AD_BUDGETS"], amount, entryType: "AD_BUDGET_RESERVED", reference, description });
  } else {
    await ledger.mvecEarned({ from: ["VENDOR_PAYABLE", vendorId], amount, entryType: "SUBSCRIPTION_FEE", reference, description });
  }
  return charged;
}

// Puts money back on the available balance, recorded as a negative charge.
async function creditBalance(vendorId, amount, { type, reference, description }) {
  if (!(amount > 0)) return;
  const VendorWallet = require("../models/VendorWallet");
  await VendorWallet.findOneAndUpdate({ vendor: vendorId }, { $inc: { availableBalance: amount } }, { upsert: true });
  await SellerCharge.create({ vendor: vendorId, type, amount: -amount, reference, description });
  if (type === "ADVERTISING") {
    await require("./ledger.service").post({ from: ["AD_BUDGETS"], to: ["VENDOR_PAYABLE", vendorId], amount, entryType: "AD_BUDGET_RETURNED", reference, description });
  }
}

// What a campaign really took from the seller (charges minus returns).
async function netCharged(reference) {
  const rows = await SellerCharge.find({ reference, type: "ADVERTISING" }).select("amount").lean();
  return rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
}

module.exports = { orderLines, summary, statement, notify, chargeBalance, creditBalance, netCharged };
