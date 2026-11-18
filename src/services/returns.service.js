// Returns after delivery, as on Jumia or Amazon: the buyer asks to send items
// back within the return window, the seller approves (with instructions) or
// says no, the buyer sends the items back, the seller confirms they arrived
// and the buyer is refunded. Ikiguzi decides when the two sides disagree or
// the seller doesn't answer in time.
//
//   REQUESTED → APPROVED → RECEIVED → REFUNDED
//   REQUESTED → REJECTED → (buyer asks Ikiguzi) ESCALATED → REFUNDED | REJECTED
//   REQUESTED past its answer-by date → ESCALATED (automatic)
//   the seller may also refund without the items coming back ("keep it")
//
// Money: the seller's share was released at delivery, so the refund takes it
// back from their balance (which can go below zero: later sales cover it);
// Ikiguzi gives back its commission and absorbs the payment fee; an
// affiliate's commission on it is reversed. The delivery fee isn't refunded.
const orm = require("../database/orm");
const ReturnRequest = require("../models/ReturnRequest");
const Order = require("../models/Order");
const Settlement = require("../models/Settlement");
const VendorWallet = require("../models/VendorWallet");
const AdminWallet = require("../models/AdminWallet");
const Payment = require("../models/Payment");
const Product = require("../models/Product");
const User = require("../models/User");
const Dispute = require("../models/Dispute");
const ledger = require("./ledger.service");
const variants = require("./variant.service");
const notifications = require("./notification.service");
const platformSettings = require("./platformSettings.service");

const httpError = (statusCode, message, code) => Object.assign(new Error(message), { statusCode, code });
const idOf = (v) => String(v?._id || v?.id || v || "");
const money = (n) => `${new Intl.NumberFormat("en-RW").format(Math.round(Number(n) || 0))} RWF`;
const DAY = 24 * 3600 * 1000;
const round = (n) => Math.round(n * 100) / 100;

const REASONS = {
  DAMAGED: "Arrived damaged",
  WRONG_ITEM: "Wrong item sent",
  NOT_AS_DESCRIBED: "Not as described",
  MISSING_PARTS: "Parts or accessories missing",
  DOES_NOT_FIT: "Doesn't fit",
  CHANGED_MIND: "Changed my mind",
  OTHER: "Other",
};
// The seller is at fault: the buyer shows it with a photo.
const NEEDS_PHOTO = ["DAMAGED", "WRONG_ITEM", "NOT_AS_DESCRIBED", "MISSING_PARTS"];
const OPEN = ["REQUESTED", "APPROVED", "ESCALATED", "RECEIVED"];
const LABELS = {
  REQUESTED: "Waiting for the seller",
  APPROVED: "Approved: send the items back",
  REJECTED: "The seller declined",
  ESCALATED: "Ikiguzi is reviewing",
  RECEIVED: "Items received: refunding",
  REFUNDED: "Refunded",
  CANCELLED: "Cancelled",
};
// After declining, the buyer has this long to ask Ikiguzi; after approving,
// the seller has this long to confirm the items arrived before the buyer can.
const ESCALATE_AFTER_REJECT_DAYS = 7;
const RECEIVE_WITHIN_DAYS = 7;

const step = (ret, status, note, by) => {
  ret.history = [...(ret.history || []), { status, at: new Date(), note, by }];
  ret.status = status;
};

const windowDays = async () => Number((await platformSettings.get()).returnWindowDays ?? 7);

/** When each seller handed over their parcel of this order (their settlements' release). */
async function deliveredAtBySeller(orderId) {
  const released = await Settlement.find({ order: orderId, status: "RELEASED" }).select("vendor releasedAt").lean();
  const out = new Map();
  for (const s of released) {
    const t = s.releasedAt ? new Date(s.releasedAt) : null;
    const prev = out.get(idOf(s.vendor));
    if (t && (!prev || t > prev)) out.set(idOf(s.vendor), t);
  }
  return out;
}

/** Units of each order item already in a return that isn't closed against the buyer. */
async function claimedUnits(orderId) {
  const rows = await ReturnRequest.find({ order: orderId, status: { $nin: ["REJECTED", "CANCELLED"] } }).select("items").lean();
  const out = new Map();
  for (const r of rows) for (const i of r.items || []) out.set(i.orderItemId, (out.get(i.orderItemId) || 0) + Number(i.quantity));
  return out;
}

/** What the buyer can still send back from an order, and until when. */
async function eligibility(user, orderId) {
  if (!orm.isValidObjectId(orderId)) throw httpError(404, "Order not found.");
  const order = await Order.findById(orderId).lean();
  if (!order || idOf(order.user) !== idOf(user)) throw httpError(404, "Order not found.");
  const days = await windowDays();
  const delivered = await deliveredAtBySeller(order._id);
  const claimed = await claimedUnits(order._id);
  const now = Date.now();
  const items = (order.items || []).map((i) => {
    const at = delivered.get(idOf(i.vendor));
    const deadline = at ? new Date(at.getTime() + days * DAY) : null;
    const left = Math.max(0, Number(i.quantity) - (claimed.get(idOf(i)) || 0));
    let why = null;
    if (!at) why = "Not delivered yet.";
    else if (days <= 0 || now > deadline.getTime()) why = "The return window has closed.";
    else if (!left) why = "Already being returned.";
    return {
      orderItemId: idOf(i), product: idOf(i.product), vendor: idOf(i.vendor), name: i.name, variantLabel: i.variantLabel || null,
      image: i.image || "", price: Number(i.price), quantity: Number(i.quantity), returnable: why ? 0 : left, deadline, why,
    };
  });
  return { windowDays: days, items, reasons: Object.entries(REASONS).map(([code, label]) => ({ code, label, needsPhoto: NEEDS_PHOTO.includes(code) })) };
}

/** The refund for `quantity` units of an order item: its share of what the buyer paid for that line. */
async function lineRefund(orderId, item, quantity) {
  const settlement = await Settlement.findOne({ order: orderId, orderItemId: idOf(item) }).lean();
  const share = quantity / Number(item.quantity);
  if (settlement) return round(Number(settlement.grossAmount) * share);
  return round((Number(item.price) * Number(item.quantity) - (Number(item.discount) || 0)) * share);
}

/**
 * The buyer asks to return items: [{ orderItemId, quantity }] with a reason,
 * a description and (when the seller is at fault) photos. Items from several
 * sellers become one request per seller.
 */
async function create(user, { orderId, items = [], reason, description = "", photos = [] } = {}) {
  const code = String(reason || "").toUpperCase();
  if (!REASONS[code]) throw httpError(400, "Choose why you're returning it.");
  const text = String(description || "").trim();
  if (text.length < 5) throw httpError(400, "Tell the seller a little about the problem (a few words at least).");
  const pics = (Array.isArray(photos) ? photos : []).map(String).filter((u) => /^(https?:\/\/|\/uploads\/)/.test(u)).slice(0, 5);
  if (NEEDS_PHOTO.includes(code) && !pics.length) throw httpError(400, "Add a photo that shows the problem, so the seller can see it.");
  if (!Array.isArray(items) || !items.length) throw httpError(400, "Choose the items to return.");

  const { items: allowed } = await eligibility(user, orderId);
  const order = await Order.findById(orderId).lean();
  if (order.paymentStatus !== "PAID") {
    throw httpError(409, order.paymentStatus === "DISPUTED" ? "This order has a problem report open. Finish it first." : "Only paid orders can be returned.");
  }
  if (await Dispute.exists({ order: order._id, status: { $in: ["OPEN", "UNDER_REVIEW", "EVIDENCE_SUBMITTED"] } })) {
    throw httpError(409, "This order has a problem report open. Finish it first.");
  }
  const bySeller = new Map();
  for (const want of items) {
    const line = allowed.find((a) => a.orderItemId === String(want.orderItemId));
    const qty = Number(want.quantity);
    if (!line) throw httpError(400, "One of the items isn't in this order.");
    if (!Number.isInteger(qty) || qty < 1) throw httpError(400, `Choose how many of ${line.name} to return.`);
    if (qty > line.returnable) throw httpError(400, line.why ? `${line.name}: ${line.why}` : `You can return at most ${line.returnable} of ${line.name}.`);
    if (!bySeller.has(line.vendor)) bySeller.set(line.vendor, []);
    bySeller.get(line.vendor).push({ line, qty });
  }
  const days = Number((await platformSettings.get()).disputeResponseDays) || 3;
  const created = [];
  for (const [vendor, lines] of bySeller) {
    let refund = 0;
    const rows = [];
    for (const { line, qty } of lines) {
      const orderItem = order.items.find((i) => idOf(i) === line.orderItemId);
      refund += await lineRefund(order._id, orderItem, qty);
      rows.push({ orderItemId: line.orderItemId, product: line.product, variant: orderItem.variant ? idOf(orderItem.variant) : null, name: line.name, variantLabel: line.variantLabel, quantity: qty, price: line.price, image: line.image });
    }
    const ret = new ReturnRequest({
      returnNumber: `RET-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`,
      order: order._id, buyer: idOf(user), vendor, items: rows, reason: code, description: text.slice(0, 2000), photos: pics,
      refundAmount: round(refund), respondBy: new Date(Date.now() + days * DAY), status: "REQUESTED",
      history: [{ status: "REQUESTED", at: new Date(), note: `${REASONS[code]}: ${text.slice(0, 200)}`, by: "buyer" }],
    });
    await ret.save();
    created.push(ret);
    notifications.notify(vendor, {
      type: "ORDER", title: `Return request for order ${order.orderNumber}`,
      message: `${rows.map((r) => `${r.quantity} × ${r.name}`).join(", ")} (${REASONS[code].toLowerCase()}). Answer by ${new Date(ret.respondBy).toLocaleDateString("en-GB")} or Ikiguzi decides.`,
      link: "/vendor/returns", sms: `Ikiguzi: a buyer wants to return items from order ${order.orderNumber}. Answer in the app within ${days} days.`,
    }).catch(() => {});
  }
  return { returns: created.map(view) };
}

function view(ret) {
  const r = ret.toObject ? ret.toObject() : ret;
  return { ...r, id: idOf(r), statusLabel: LABELS[r.status], reasonLabel: REASONS[r.reason] };
}

async function load(id) {
  if (!orm.isValidObjectId(id)) throw httpError(404, "Return not found.");
  const ret = await ReturnRequest.findById(id);
  if (!ret) throw httpError(404, "Return not found.");
  return ret;
}

const sellerOf = (user, req = {}) => String(req.vendorId || req.targetVendorId || idOf(user));

async function mine(user) {
  const rows = await ReturnRequest.find({ buyer: idOf(user) }).sort({ createdAt: -1 }).limit(100).lean();
  return { returns: rows.map(view) };
}

async function forSeller(user, req, { status } = {}) {
  const filter = { vendor: sellerOf(user, req) };
  if (status) filter.status = String(status).toUpperCase();
  const rows = await ReturnRequest.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  const orders = await Order.find({ _id: { $in: rows.map((r) => r.order) } }).select("orderNumber recipient").lean();
  const byId = new Map(orders.map((o) => [idOf(o), o]));
  return { returns: rows.map((r) => ({ ...view(r), orderNumber: byId.get(idOf(r.order))?.orderNumber || "", buyerName: byId.get(idOf(r.order))?.recipient?.name || "" })) };
}

async function forAdmin({ status } = {}) {
  const filter = status ? { status: String(status).toUpperCase() } : {};
  const rows = await ReturnRequest.find(filter).sort({ createdAt: -1 }).limit(200).lean();
  return { returns: rows.map(view) };
}

async function getOne(user, id) {
  const ret = await load(id);
  const me = idOf(user);
  if (user.role !== "super_admin" && idOf(ret.buyer) !== me && idOf(ret.vendor) !== me) throw httpError(404, "Return not found.");
  return { return: view(ret) };
}

const tellBuyer = (ret, title, message, sms) =>
  notifications.notify(ret.buyer, { type: "ORDER", title, message, link: `/account/returns`, sms }).catch(() => {});

/* ------------------------------- the seller ------------------------------ */

async function ownBySeller(user, req, id) {
  const ret = await load(id);
  if (user.role !== "super_admin" && idOf(ret.vendor) !== sellerOf(user, req)) throw httpError(404, "Return not found.");
  return ret;
}

async function approve(user, req, id, { instructions = "" } = {}) {
  const ret = await ownBySeller(user, req, id);
  if (ret.status !== "REQUESTED") throw httpError(409, `This return is ${LABELS[ret.status].toLowerCase()}.`);
  const how = String(instructions || "").trim().slice(0, 1000) || "Bring the items back to the store, or arrange a pickup with the seller through Ikiguzi messages.";
  ret.sellerNote = how;
  ret.approvedAt = new Date();
  step(ret, "APPROVED", how, "seller");
  await ret.save();
  tellBuyer(ret, `Return ${ret.returnNumber} approved`, `Send the items back: ${how} You're refunded ${money(ret.refundAmount)} once the seller has them.`, `Ikiguzi: your return ${ret.returnNumber} was approved. See the app for how to send it back.`);
  return { return: view(ret) };
}

async function reject(user, req, id, { reason = "" } = {}) {
  const ret = await ownBySeller(user, req, id);
  if (ret.status !== "REQUESTED") throw httpError(409, `This return is ${LABELS[ret.status].toLowerCase()}.`);
  const why = String(reason || "").trim();
  if (why.length < 5) throw httpError(400, "Tell the buyer why, in a few words.");
  ret.sellerNote = why.slice(0, 1000);
  step(ret, "REJECTED", why, "seller");
  await ret.save();
  tellBuyer(ret, `Return ${ret.returnNumber} declined`, `The seller said: ${why} If you disagree, ask Ikiguzi to decide within ${ESCALATE_AFTER_REJECT_DAYS} days.`);
  return { return: view(ret) };
}

/** The items came back: refund now (and put them back in stock unless they're damaged). */
async function received(user, req, id, { restock = true } = {}) {
  const ret = await ownBySeller(user, req, id);
  if (ret.status !== "APPROVED") throw httpError(409, ret.status === "REQUESTED" ? "Approve the return first." : `This return is ${LABELS[ret.status].toLowerCase()}.`);
  ret.receivedAt = new Date();
  step(ret, "RECEIVED", restock ? "The seller has the items (back in stock)" : "The seller has the items", "seller");
  await ret.save();
  return refund(ret, { restock: Boolean(restock), by: "seller" });
}

/** Refund without the items coming back (cheap or damaged items). */
async function refundWithoutReturn(user, req, id) {
  const ret = await ownBySeller(user, req, id);
  if (!["REQUESTED", "APPROVED"].includes(ret.status)) throw httpError(409, `This return is ${LABELS[ret.status].toLowerCase()}.`);
  step(ret, ret.status, "The seller refunded without asking for the items back", "seller");
  return refund(ret, { restock: false, by: "seller" });
}

/* ------------------------------- the buyer ------------------------------- */

async function ownByBuyer(user, id) {
  const ret = await load(id);
  if (idOf(ret.buyer) !== idOf(user)) throw httpError(404, "Return not found.");
  return ret;
}

async function cancel(user, id) {
  const ret = await ownByBuyer(user, id);
  if (!["REQUESTED", "APPROVED"].includes(ret.status)) throw httpError(409, `This return is ${LABELS[ret.status].toLowerCase()}; it can't be cancelled now.`);
  step(ret, "CANCELLED", "The buyer cancelled the return", "buyer");
  await ret.save();
  notifications.notify(ret.vendor, { type: "ORDER", title: `Return ${ret.returnNumber} cancelled`, message: "The buyer is keeping the items.", link: "/vendor/returns" }).catch(() => {});
  return { return: view(ret) };
}

/** The buyer asks Ikiguzi to decide: after a no, or when an approved return isn't confirmed in time. */
async function escalate(user, id, { reason = "" } = {}) {
  const ret = await ownByBuyer(user, id);
  const now = Date.now();
  const last = new Date(ret.history?.[ret.history.length - 1]?.at || ret.updatedAt).getTime();
  const ok =
    (ret.status === "REJECTED" && now - last <= ESCALATE_AFTER_REJECT_DAYS * DAY) ||
    (ret.status === "APPROVED" && ret.approvedAt && now - new Date(ret.approvedAt).getTime() >= RECEIVE_WITHIN_DAYS * DAY) ||
    (ret.status === "REQUESTED" && ret.respondBy && now > new Date(ret.respondBy).getTime());
  if (!ok) {
    throw httpError(409, ret.status === "APPROVED"
      ? `The seller has ${RECEIVE_WITHIN_DAYS} days to confirm the items arrived. You can ask Ikiguzi after that.`
      : ret.status === "REJECTED" ? `You could ask Ikiguzi within ${ESCALATE_AFTER_REJECT_DAYS} days of the seller's answer.`
        : "Wait for the seller's answer first.");
  }
  step(ret, "ESCALATED", String(reason || "The buyer asked Ikiguzi to decide").slice(0, 500), "buyer");
  await ret.save();
  notifications.adminAlert({ title: "Return to decide", message: `Return ${ret.returnNumber} (${money(ret.refundAmount)}) needs Ikiguzi's decision.`, link: "/admin/returns" }).catch(() => {});
  notifications.notify(ret.vendor, { type: "ORDER", title: `Ikiguzi is reviewing return ${ret.returnNumber}`, message: "Reply in the return's messages if you want Ikiguzi to know your side.", link: "/vendor/returns" }).catch(() => {});
  return { return: view(ret) };
}

/* --------------------------------- admin --------------------------------- */

async function decide(admin, id, { decision, note = "" } = {}) {
  const ret = await load(id);
  if (!["REQUESTED", "APPROVED", "REJECTED", "ESCALATED", "RECEIVED"].includes(ret.status)) throw httpError(409, `This return is ${LABELS[ret.status].toLowerCase()}.`);
  const d = String(decision || "").toUpperCase();
  const why = String(note || "").trim().slice(0, 1000);
  if (!["REFUND", "REJECT"].includes(d)) throw httpError(400, "Choose to refund the buyer or close the return.");
  if (why.length < 5) throw httpError(400, "Write a short note: both sides see it.");
  ret.adminNote = why;
  if (d === "REJECT") {
    step(ret, "REJECTED", `Ikiguzi decided: ${why}`, "admin");
    await ret.save();
    tellBuyer(ret, `Return ${ret.returnNumber}: Ikiguzi's decision`, `No refund: ${why}`);
    notifications.notify(ret.vendor, { type: "ORDER", title: `Return ${ret.returnNumber} closed by Ikiguzi`, message: why, link: "/vendor/returns" }).catch(() => {});
    return { return: view(ret) };
  }
  step(ret, ret.status, `Ikiguzi decided to refund: ${why}`, "admin");
  return refund(ret, { restock: false, by: "admin" });
}

/** Seller didn't answer by the answer-by date: Ikiguzi decides (every minute, slaWorker). */
async function escalateOverdue(now = new Date()) {
  const overdue = await ReturnRequest.find({ status: "REQUESTED", respondBy: { $lte: now } });
  for (const ret of overdue) {
    step(ret, "ESCALATED", "The seller didn't answer in time", "system");
    await ret.save();
    notifications.adminAlert({ title: "Return to decide", message: `The seller didn't answer return ${ret.returnNumber} in time.`, link: "/admin/returns" }).catch(() => {});
    tellBuyer(ret, `Ikiguzi is reviewing return ${ret.returnNumber}`, "The seller didn't answer in time, so Ikiguzi will decide.");
  }
  return overdue.length;
}

/* --------------------------------- money --------------------------------- */

/**
 * Pays the buyer back for the returned items, from what each party received
 * for them, then sends it to the number (or card) that paid.
 */
async function refund(ret, { restock = false, by = "seller" } = {}) {
  const session = await orm.startSession();
  session.startTransaction();
  let order;
  try {
    order = await Order.findById(ret.order).session(session);
    if (!order) throw httpError(404, "Order not found.");
    const admin = await User.findOne({ role: "super_admin" }).sort({ createdAt: 1 }).select("_id").session(session);
    let total = 0;
    for (const item of ret.items) {
      const orderItem = order.items.find((i) => idOf(i) === item.orderItemId);
      const settlement = await Settlement.findOne({ order: order._id, orderItemId: item.orderItemId }).session(session);
      if (!orderItem || !settlement) throw httpError(409, `${item.name} has no payment record; Ikiguzi support must refund it.`);
      if (settlement.status !== "RELEASED") throw httpError(409, `${item.name} isn't delivered yet; it can't be returned.`);
      const f = Number(item.quantity) / Number(orderItem.quantity);
      const gross = round(Number(settlement.grossAmount) * f);
      const net = round(Number(settlement.netAmount) * f);
      const affiliate = round((Number(settlement.affiliateShare) || 0) * f);
      const ikiguzi = round(gross - net - affiliate); // commission + the payment fee Ikiguzi absorbs
      const common = { order: order._id, session, to: ["BUYER_REFUND_HOLD"], entryType: "BUYER_REFUND" };
      await ledger.post({ ...common, from: ["VENDOR_PAYABLE", settlement.vendor], amount: net, description: `Return ${ret.returnNumber}: seller's share back` });
      await ledger.post({ ...common, from: ["PLATFORM_REVENUE"], amount: ikiguzi, description: `Return ${ret.returnNumber}: Ikiguzi's share back` });
      await ledger.post({ ...common, from: ["AFFILIATE_COMMISSION"], amount: affiliate, description: `Return ${ret.returnNumber}: affiliate commission back` });
      await VendorWallet.updateOne({ vendor: settlement.vendor }, { $inc: { availableBalance: -net, totalEarned: -net } }, { session });
      const walletShare = round(((Number(settlement.adminShare) || 0) + (Number(settlement.developerShare) || 0)) * f);
      if (walletShare > 0 && admin) await AdminWallet.updateOne({ adminUser: admin._id }, { $inc: { availableBalance: -walletShare, totalEarned: -walletShare } }, { session });
      total += gross;
    }
    total = round(total);
    ret.refundAmount = total;
    ret.refundedAt = new Date();
    step(ret, "REFUNDED", `${money(total)} refunded`, by);
    await ret.save({ session });
    await session.commitTransaction();
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }

  if (restock) {
    for (const item of ret.items) {
      if (item.variant) await variants.giveBack(item.variant, Number(item.quantity));
      await Product.updateOne({ _id: item.product }, { $inc: { stockQuantity: Number(item.quantity) } });
      await Product.updateOne({ _id: item.product, status: "OUT_OF_STOCK", stockQuantity: { $gt: 0 } }, { $set: { status: "ACTIVE" } });
    }
  }
  await require("./affiliateAttribution.service").reverseOrderCommission({
    orderId: order._id, refundAmount: ret.refundAmount, key: `return:${idOf(ret)}`, reason: `Return ${ret.returnNumber}`,
  }).catch((err) => console.error(`Affiliate reversal for return ${idOf(ret)} failed:`, err.message));
  const payment = await Payment.findOne({ parentOrder: order._id, status: "SUCCESS" }).sort({ createdAt: -1 }).lean();
  await require("./disbursement.service").refundPayment({ order, payment, amount: ret.refundAmount, idempotencyKey: `return-refund:${idOf(ret)}` })
    .catch((err) => console.error(`Return refund ${idOf(ret)} failed to queue:`, err.message));
  tellBuyer(ret, `Refund for return ${ret.returnNumber}`, `${money(ret.refundAmount)} is on its way to the number or card you paid with.`, `Ikiguzi: ${money(ret.refundAmount)} for return ${ret.returnNumber} is on its way to you.`);
  notifications.notify(ret.vendor, { type: "ORDER", title: `Return ${ret.returnNumber} refunded`, message: `${money(ret.refundAmount)} was refunded to the buyer; your share was taken from your balance.`, link: "/vendor/returns" }).catch(() => {});
  return { return: view(ret) };
}

module.exports = {
  REASONS, LABELS, eligibility, create, mine, forSeller, forAdmin, getOne,
  approve, reject, received, refundWithoutReturn, cancel, escalate, decide, escalateOverdue,
};
