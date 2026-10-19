// Problem reports as a case the buyer, the seller and MVEC work through.
//
//   1. Buyer reports a problem: the payment is frozen and the seller has
//      `disputeResponseDays` (admin setting) to respond.
//   2. Seller resolves it directly: full refund, or a partial-refund offer the
//      buyer accepts or declines, or replies with their side.
//   3. Either side can ask MVEC to decide. MVEC also steps in automatically if
//      the seller doesn't respond in time, or the buyer declines an offer.
//   4. MVEC decides: refund the buyer, pay the seller, or split, with a note
//      both sides see. The money moves at once (dispute.service).
//   5. The buyer can withdraw the report once the problem is solved; the
//      order then carries on normally.
// Every step is written to the case timeline and both sides are notified.
const orm = require("../database/orm");
const Dispute = require("../models/Dispute");
const DisputeEvidence = require("../models/DisputeEvidence");
const Order = require("../models/Order");
const Settlement = require("../models/Settlement");
const User = require("../models/User");
const disputeService = require("./dispute.service");
const settings = require("./platformSettings.service");

const DAY = 24 * 60 * 60 * 1000;
const CLOSED = ["RESOLVED_BUYER_REFUNDED", "RESOLVED_VENDOR_RELEASED", "RESOLVED_SPLIT", "REJECTED", "WITHDRAWN"];
const isClosed = (d) => CLOSED.includes(d.status);
const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const money = (n) => `${Math.round(Number(n) || 0).toLocaleString("en-RW")} RWF`;
const notifications = () => require("./notification.service");

// One line on the case timeline written by the system (not a person).
async function event(dispute, actorId, text, session = null) {
  await DisputeEvidence.create([{ dispute: dispute._id, submittedBy: actorId || dispute.raisedBy, senderRole: "system", message: text, attachments: [] }], { session });
}

async function load(disputeId) {
  if (!orm.isValidObjectId(disputeId)) throw httpError(404, "Case not found.");
  const dispute = await Dispute.findById(disputeId);
  if (!dispute) throw httpError(404, "Case not found.");
  const order = await Order.findById(dispute.order);
  if (!order) throw httpError(404, "The order for this case no longer exists.");
  return { dispute, order };
}

const sellersOf = (order) => [...new Set((order.items || []).filter((i) => i.vendor).map((i) => String(i.vendor._id || i.vendor)))];

// Who the requester is in this case: "buyer", "seller", "admin" or null.
function partyOf(user, dispute, order) {
  if (!user) return null;
  if (user.role === "super_admin") return "admin";
  const id = String(user.id || user._id);
  if (String(dispute.raisedBy) === id) return "buyer";
  if (String(dispute.vendor) === id || sellersOf(order).includes(id)) return "seller";
  return null;
}

// Money currently held for the order (what a decision can move).
async function heldFor(orderId) {
  const held = await Settlement.find({ order: orderId, status: { $in: ["HELD", "ADMIN_HOLD"] } }).select("grossAmount netAmount").lean();
  const gross = held.reduce((n, s) => n + Number(s.grossAmount || 0), 0);
  const net = held.reduce((n, s) => n + Number(s.netAmount || 0), 0);
  return { gross: Math.round(gross * 100) / 100, net: Math.round(net * 100) / 100 };
}

function actionsFor(party, dispute) {
  const open = !isClosed(dispute);
  const reviewing = dispute.status === "UNDER_REVIEW";
  const offerPending = dispute.offerStatus === "PENDING";
  return {
    reply: open && Boolean(party),
    // Seller
    fullRefund: open && party === "seller",
    offer: open && party === "seller" && !reviewing && !offerPending,
    // Buyer
    acceptOffer: open && party === "buyer" && offerPending,
    declineOffer: open && party === "buyer" && offerPending,
    withdraw: open && party === "buyer",
    // Both
    escalate: open && (party === "buyer" || party === "seller") && !reviewing,
    // MVEC
    decide: open && party === "admin",
  };
}

// What the case looks like to the requester.
async function getCase(disputeId, user) {
  const { dispute, order } = await load(disputeId);
  const party = partyOf(user, dispute, order);
  if (!party) throw httpError(404, "Case not found.");
  const [timeline, people, held] = await Promise.all([
    DisputeEvidence.find({ dispute: dispute._id }).sort({ createdAt: 1 }).lean(),
    User.find({ _id: { $in: [dispute.raisedBy, dispute.vendor] } }).select("Fullname companyName").lean(),
    heldFor(order._id),
  ]);
  const nameOf = (id) => { const u = people.find((p) => String(p._id) === String(id)); return u ? (u.companyName || u.Fullname) : ""; };
  const body = dispute.toJSON ? dispute.toJSON() : dispute;
  return {
    case: {
      ...body,
      id: String(dispute._id),
      buyerName: nameOf(dispute.raisedBy),
      sellerName: nameOf(dispute.vendor),
      held,
      order: {
        id: String(order._id), orderNumber: order.orderNumber, totalAmount: Number(order.totalAmount),
        orderStatus: order.orderStatus, paymentStatus: order.paymentStatus, createdAt: order.createdAt,
        items: (order.items || []).map((i) => ({ name: i.name, quantity: i.quantity, price: Number(i.price) })),
      },
    },
    timeline: timeline.map((e) => ({
      id: String(e._id), role: e.senderRole, message: e.message, attachments: e.attachments || [], createdAt: e.createdAt,
      who: e.senderRole === "system" ? "MVEC" : e.senderRole === "super_admin" ? "MVEC support" : e.senderRole === "buyer" ? (nameOf(e.submittedBy) || "Buyer") : (nameOf(e.submittedBy) || "Seller"),
    })),
    you: party,
    actions: actionsFor(party, dispute),
  };
}

async function updateAll(order, dispute, messages) {
  await notifications().disputeUpdate(order, dispute, messages).catch(() => {});
  require("./socket.service").emitToRoom(`dispute:${dispute._id}`, "dispute_updated", { id: String(dispute._id), status: dispute.status });
}

// ── Seller ──────────────────────────────────────────────────────────────────
async function sellerFullRefund(disputeId, user, note = "") {
  const { dispute, order } = await load(disputeId);
  if (partyOf(user, dispute, order) !== "seller") throw httpError(403, "Only the seller can refund this order.");
  if (isClosed(dispute)) throw httpError(400, "This case is already closed.");
  const resolved = await disputeService.resolveDisputeArbitration({
    disputeId, adminId: user.id, decision: "REFUND_BUYER",
    notes: `The seller refunded the order in full.${note ? ` ${String(note).slice(0, 300)}` : ""}`,
  });
  await event(resolved, user.id, `The seller refunded ${money(order.totalAmount)} in full. The money is on its way back to the buyer.`);
  await finish(resolved);
  return resolved;
}

async function sellerOffer(disputeId, user, { amount, note }) {
  const { dispute, order } = await load(disputeId);
  if (partyOf(user, dispute, order) !== "seller") throw httpError(403, "Only the seller can make an offer.");
  if (isClosed(dispute)) throw httpError(400, "This case is already closed.");
  if (dispute.status === "UNDER_REVIEW") throw httpError(400, "MVEC is deciding this case. You can still refund in full, or reply with your side.");
  if (dispute.offerStatus === "PENDING") throw httpError(400, "The buyer hasn't answered your last offer yet.");
  const held = await heldFor(order._id);
  const value = Math.round(Number(amount));
  if (!Number.isFinite(value) || value <= 0) throw httpError(400, "Enter the amount you'll refund.");
  if (value >= held.gross) throw httpError(400, `For ${money(held.gross)} or more, use "Refund in full".`);
  Object.assign(dispute, { offerAmount: value, offerNote: String(note || "").trim().slice(0, 500), offerStatus: "PENDING", offeredAt: new Date(), status: "EVIDENCE_SUBMITTED" });
  await dispute.save();
  await event(dispute, user.id, `The seller offered a partial refund of ${money(value)}${dispute.offerNote ? `: “${dispute.offerNote}”` : ""}. The buyer can accept or decline.`);
  await updateAll(order, dispute, {
    buyer: { title: `Refund offer on ${order.orderNumber}`, message: `The seller offers to refund ${money(value)}. Accept it, or decline and MVEC will decide.` },
  });
  return dispute;
}

// ── Buyer ───────────────────────────────────────────────────────────────────
async function buyerRespondOffer(disputeId, user, accept) {
  const { dispute, order } = await load(disputeId);
  if (partyOf(user, dispute, order) !== "buyer") throw httpError(403, "Only the buyer can answer this offer.");
  if (dispute.offerStatus !== "PENDING" || isClosed(dispute)) throw httpError(400, "There's no offer waiting for your answer.");
  if (accept) {
    const held = await heldFor(order._id);
    const refund = Math.min(Number(dispute.offerAmount), held.gross);
    // The seller gets their usual share of what isn't refunded; MVEC keeps its fee on that part.
    const release = held.gross > 0 ? Math.round(((held.gross - refund) * held.net) / held.gross) : 0;
    dispute.offerStatus = "ACCEPTED";
    await dispute.save();
    const resolved = await disputeService.resolveDisputeArbitration({
      disputeId, adminId: user.id, decision: "SPLIT_SETTLEMENT", buyerRefundAmount: refund, vendorReleaseAmount: release,
      notes: `The buyer accepted the seller's partial refund of ${money(refund)}.`,
    });
    await event(resolved, user.id, `The buyer accepted the partial refund. ${money(refund)} is on its way to the buyer and ${money(release)} is released to the seller.`);
    await finish(resolved);
    return resolved;
  }
  dispute.offerStatus = "DECLINED";
  await dispute.save();
  await event(dispute, user.id, `The buyer declined the ${money(dispute.offerAmount)} offer.`);
  return escalate(disputeId, user, "The buyer declined the seller's offer", { silentEvent: false });
}

async function withdraw(disputeId, user, note = "") {
  const { dispute, order } = await load(disputeId);
  if (partyOf(user, dispute, order) !== "buyer") throw httpError(403, "Only the buyer can withdraw this report.");
  if (isClosed(dispute)) throw httpError(400, "This case is already closed.");
  const session = await orm.startSession();
  session.startTransaction();
  try {
    dispute.status = "WITHDRAWN";
    dispute.closedAt = new Date();
    if (dispute.offerStatus === "PENDING") dispute.offerStatus = "DECLINED";
    await dispute.save({ session });
    // The payment is no longer frozen: the order carries on as normal.
    if (order.paymentStatus === "DISPUTED") order.paymentStatus = "PAID";
    await order.save({ session });
    await event(dispute, user.id, `The buyer withdrew the report${note ? `: “${String(note).slice(0, 300)}”` : ""}. The order continues as normal.`, session);
    await session.commitTransaction();
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
  await updateAll(order, dispute, {
    seller: { title: `Problem report withdrawn on ${order.orderNumber}`, message: "The buyer says the problem is solved. The payment is no longer on hold; deliver as usual." },
    admin: { title: `Report withdrawn on ${order.orderNumber}`, message: "The buyer withdrew the problem report." },
  });
  return dispute;
}

// ── Either side, or automatic ───────────────────────────────────────────────
async function escalate(disputeId, user, reason = "", { silentEvent = false } = {}) {
  const { dispute, order } = await load(disputeId);
  const party = user ? partyOf(user, dispute, order) : "system";
  if (user && !["buyer", "seller"].includes(party)) throw httpError(403, "Only the buyer or the seller can ask MVEC to decide.");
  if (isClosed(dispute)) throw httpError(400, "This case is already closed.");
  if (dispute.status === "UNDER_REVIEW") return dispute;
  const why = String(reason || (party === "buyer" ? "The buyer asked MVEC to decide" : party === "seller" ? "The seller asked MVEC to decide" : "No agreement in time")).slice(0, 300);
  Object.assign(dispute, { status: "UNDER_REVIEW", escalatedAt: new Date(), escalationReason: why });
  if (dispute.offerStatus === "PENDING") dispute.offerStatus = "DECLINED";
  await dispute.save();
  if (!silentEvent) await event(dispute, user?.id, `${why}. MVEC is now reviewing the case and will decide.`);
  await updateAll(order, dispute, {
    buyer: { title: `MVEC is reviewing ${order.orderNumber}`, message: `${why}. MVEC will look at both sides and decide; you'll be told the outcome.` },
    seller: { title: `MVEC is reviewing ${order.orderNumber}`, message: `${why}. Add anything that supports your side on the case; MVEC will decide.` },
    admin: { title: `Decision needed: ${dispute.disputeNumber}`, message: `${why}. Review the case and decide.` },
  });
  return dispute;
}

// Called after any decision (MVEC, seller refund, accepted offer).
async function finish(dispute) {
  const fresh = await Dispute.findById(dispute._id);
  if (fresh && !fresh.closedAt) { fresh.closedAt = new Date(); await fresh.save(); }
  const order = await Order.findById(dispute.order);
  const d = fresh || dispute;
  const decision = d.arbitrationDecision || {};
  const outcome = d.status === "RESOLVED_BUYER_REFUNDED"
    ? `The buyer is refunded ${money(decision.buyerRefundAmount || order?.totalAmount)}.`
    : d.status === "RESOLVED_VENDOR_RELEASED" ? "The payment is released to the seller."
    : `The buyer is refunded ${money(decision.buyerRefundAmount)} and ${money(decision.vendorReleaseAmount)} is released to the seller.`;
  if (order) {
    await updateAll(order, d, {
      buyer: { title: `Your report on ${order.orderNumber} is resolved`, message: `${outcome}${decision.notes ? ` ${decision.notes}` : ""}` },
      seller: { title: `Case resolved on ${order.orderNumber}`, message: `${outcome}${decision.notes ? ` ${decision.notes}` : ""}` },
      admin: { title: `Case ${d.disputeNumber} resolved`, message: outcome },
    });
  }
}

// MVEC's decision (admin): moves the money, records it, tells both sides.
async function decide(disputeId, user, { decision, buyerRefundAmount, vendorReleaseAmount, notes }) {
  if (!String(notes || "").trim()) throw httpError(400, "Explain the decision; both sides will see it.");
  const resolved = await disputeService.resolveDisputeArbitration({ disputeId, adminId: user.id, decision, buyerRefundAmount, vendorReleaseAmount, notes: String(notes).trim().slice(0, 1000) });
  const label = decision === "REFUND_BUYER" ? "refund the buyer in full" : decision === "RELEASE_TO_VENDOR" ? "pay the seller" : `refund the buyer ${money(buyerRefundAmount)} and release ${money(vendorReleaseAmount)} to the seller`;
  await event(resolved, user.id, `MVEC decided to ${label}. Reason: ${String(notes).trim()}`);
  await finish(resolved);
  return resolved;
}

// Background job: MVEC steps in when the seller doesn't respond by the
// deadline, or the buyer doesn't answer an offer within the same time.
async function escalateOverdue(now = new Date()) {
  const days = Number((await settings.get()).disputeResponseDays) || 3;
  const open = await Dispute.find({ status: { $in: ["OPEN", "EVIDENCE_SUBMITTED"] } });
  let escalated = 0;
  for (const d of open) {
    const deadline = d.respondBy ? new Date(d.respondBy) : new Date(new Date(d.createdAt).getTime() + days * DAY);
    const sellerSilent = d.status === "OPEN" && deadline <= now;
    const offerExpired = d.offerStatus === "PENDING" && d.offeredAt && new Date(d.offeredAt).getTime() + days * DAY <= now.getTime();
    if (!sellerSilent && !offerExpired) continue;
    await escalate(d._id, null, sellerSilent ? `The seller didn't respond within ${days} day${days === 1 ? "" : "s"}` : `The buyer didn't answer the offer within ${days} day${days === 1 ? "" : "s"}`).catch(() => {});
    escalated += 1;
  }
  return { escalated };
}

module.exports = { getCase, sellerFullRefund, sellerOffer, buyerRespondOffer, withdraw, escalate, decide, escalateOverdue, isClosed, CLOSED };
