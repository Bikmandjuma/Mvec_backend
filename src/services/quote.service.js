// Quote requests: a vendor needs goods that are not (or not enough) in any
// supplier's catalog. They post what they need; verified suppliers send a
// quote; the vendor accepts one and it becomes a normal wholesale order that
// they pay into escrow. Everyone is notified at each step.
//
//   QuoteRequest OPEN → AWARDED (a quote accepted) | CANCELLED (by the vendor) | EXPIRED (needed-by date passed)
//   Quote        SUBMITTED → ACCEPTED | DECLINED (another was accepted / request closed) | WITHDRAWN (by the supplier)
const crypto = require("crypto");
const QuoteRequest = require("../models/QuoteRequest");
const Quote = require("../models/Quote");
const Supplier = require("../models/Supplier");
const User = require("../models/User");

const httpError = (status, message) => Object.assign(new Error(message), { statusCode: status });
const idOf = (v) => String(v?._id || v || "");
const rwf = (n) => `${Math.round(Number(n) || 0).toLocaleString("en-RW")} RWF`;
const notifications = () => require("./notification.service");
const notify = (to, payload) => notifications().notify(to, payload).catch(() => {});
const MAX_LINES = 20;

function cleanLines(lines, { priced = false } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) throw httpError(400, "Add at least one item.");
  if (lines.length > MAX_LINES) throw httpError(400, `Up to ${MAX_LINES} items per request.`);
  return lines.map((l) => {
    const product = String(l.product || "").trim().slice(0, 200);
    const units = Number(l.units);
    const unit = String(l.unit || "").trim().slice(0, 40);
    if (!product || !unit || !Number.isInteger(units) || units < 1) throw httpError(400, "Each item needs a name, a whole quantity of at least 1 and a unit.");
    const out = { product, units, unit };
    if (priced) {
      const unitPrice = Math.round(Number(l.unitPrice));
      if (!Number.isFinite(unitPrice) || unitPrice <= 0) throw httpError(400, "Give a price per unit for every item.");
      out.unitPrice = unitPrice;
    } else if (l.targetPrice !== undefined && l.targetPrice !== "" && l.targetPrice !== null) {
      const t = Math.round(Number(l.targetPrice));
      if (Number.isFinite(t) && t > 0) out.targetPrice = t;
    }
    return out;
  });
}

const isOpen = (r) => r.status === "OPEN" && new Date(r.neededBy) >= new Date(new Date().setHours(0, 0, 0, 0));

class QuoteService {
  // ─── Vendor side ─────────────────────────────────────────────────────────
  async createRequest(vendorId, { category, lines, neededBy, deliverTo, note }) {
    const cat = String(category || "").trim();
    if (!cat) throw httpError(400, "Choose the category of goods you need.");
    const needed = new Date(neededBy);
    if (!neededBy || Number.isNaN(needed.getTime()) || needed < new Date(new Date().setHours(0, 0, 0, 0))) throw httpError(400, "Choose a needed-by date from today onwards.");
    const request = await QuoteRequest.create({
      reference: `RFQ-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`,
      vendor: vendorId, category: cat, lines: cleanLines(lines), neededBy: needed,
      deliverTo: String(deliverTo || "").trim().slice(0, 200), note: String(note || "").trim().slice(0, 2000),
    });
    // Tell verified suppliers in that category (or every verified supplier if none match).
    const pattern = new RegExp(`^${cat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    let suppliers = await Supplier.find({ status: "ACTIVE", verificationStatus: "VERIFIED", category: pattern }).select("user").limit(100).lean();
    if (!suppliers.length) suppliers = await Supplier.find({ status: "ACTIVE", verificationStatus: "VERIFIED" }).select("user").limit(100).lean();
    const items = request.lines.map((l) => `${l.units} ${l.unit} ${l.product}`).join(", ");
    for (const s of suppliers) {
      if (idOf(s.user) === idOf(vendorId)) continue;
      notify(s.user, { type: "ORDER", title: `New quote request: ${cat}`, message: `${items.slice(0, 160)} · needed by ${needed.toLocaleDateString("en-GB")}`, link: "/supplier/quotes" });
    }
    return { request, suppliersNotified: suppliers.length };
  }

  async listForVendor(vendorId) {
    const requests = await QuoteRequest.find({ vendor: vendorId }).sort({ createdAt: -1 }).limit(100).lean();
    const quotes = requests.length ? await Quote.find({ request: { $in: requests.map((r) => r._id) }, status: { $ne: "WITHDRAWN" } }).sort({ totalAmount: 1 }).lean() : [];
    const supplierUsers = [...new Set(quotes.map((q) => idOf(q.supplier)))];
    const suppliers = supplierUsers.length ? await Supplier.find({ user: { $in: supplierUsers } }).select("user businessName ratingAvg slug").lean() : [];
    const byUser = new Map(suppliers.map((s) => [idOf(s.user), s]));
    return requests.map((r) => ({
      ...r, id: idOf(r),
      quotes: quotes.filter((q) => idOf(q.request) === idOf(r)).map((q) => ({ ...q, id: idOf(q), supplierName: byUser.get(idOf(q.supplier))?.businessName || "Supplier", supplierRating: byUser.get(idOf(q.supplier))?.ratingAvg || 0 })),
    }));
  }

  async cancelRequest(vendorId, requestId) {
    const request = await QuoteRequest.findOne({ _id: requestId, vendor: vendorId });
    if (!request) throw httpError(404, "Quote request not found.");
    if (request.status !== "OPEN") throw httpError(409, "Only open requests can be cancelled.");
    request.status = "CANCELLED";
    await request.save();
    await this.closeQuotes(request, "The vendor cancelled the request.");
    return request;
  }

  /** Accept a quote: it becomes a wholesale order the vendor then pays. */
  async acceptQuote(vendorId, quoteId) {
    const quote = await Quote.findById(quoteId);
    if (!quote) throw httpError(404, "Quote not found.");
    const request = await QuoteRequest.findOne({ _id: quote.request, vendor: vendorId });
    if (!request) throw httpError(404, "Quote not found.");
    if (request.status !== "OPEN") throw httpError(409, "This request is no longer open.");
    if (quote.status !== "SUBMITTED") throw httpError(409, "This quote is no longer available.");
    if (quote.validUntil && new Date(quote.validUntil) < new Date()) throw httpError(409, "This quote has expired. Ask the supplier for a new one.");
    const supplier = await Supplier.findOne({ user: quote.supplier, status: "ACTIVE", verificationStatus: "VERIFIED" });
    if (!supplier) throw httpError(409, "This supplier can no longer take orders.");

    const order = await require("./wholesale.service").createFromQuote({ quote, request });
    quote.status = "ACCEPTED";
    await quote.save();
    request.status = "AWARDED";
    request.acceptedQuote = quote._id;
    request.wholesaleOrder = order._id;
    await request.save();
    await this.closeQuotes(request, "The vendor chose another quote.", quote._id);
    notify(quote.supplier, { type: "ORDER", title: `Your quote was accepted: ${request.reference}`, message: `Order ${order.orderNumber} for ${rwf(order.totalAmount)}. You will be told when the vendor pays; then ship it.`, link: "/supplier/orders" });
    return { order, request };
  }

  async closeQuotes(request, why, exceptId = null) {
    const others = await Quote.find({ request: request._id, status: "SUBMITTED", ...(exceptId ? { _id: { $ne: exceptId } } : {}) });
    for (const q of others) {
      q.status = "DECLINED";
      await q.save();
      notify(q.supplier, { type: "ORDER", title: `Quote request ${request.reference} closed`, message: why, link: "/supplier/quotes" });
    }
  }

  // ─── Supplier side ───────────────────────────────────────────────────────
  /** Open requests a supplier can quote on: their category first, then the rest. */
  async listOpenForSupplier(supplierUserId, supplierCategory) {
    const today = new Date(new Date().setHours(0, 0, 0, 0));
    const requests = await QuoteRequest.find({ status: "OPEN", neededBy: { $gte: today }, vendor: { $ne: supplierUserId } }).sort({ createdAt: -1 }).limit(100).lean();
    const mine = requests.length ? await Quote.find({ request: { $in: requests.map((r) => r._id) }, supplier: supplierUserId }).lean() : [];
    const counts = requests.length ? await Quote.find({ request: { $in: requests.map((r) => r._id) }, status: "SUBMITTED" }).select("request").lean() : [];
    const vendors = await User.find({ _id: { $in: requests.map((r) => r.vendor) } }).select("companyName Fullname").lean();
    const vName = new Map(vendors.map((v) => [idOf(v), v.companyName || v.Fullname]));
    const cat = String(supplierCategory || "").toLowerCase();
    return requests.map((r) => ({
      ...r, id: idOf(r), vendorName: vName.get(idOf(r.vendor)) || "Vendor",
      matchesMyCategory: String(r.category).toLowerCase() === cat,
      quoteCount: counts.filter((c) => idOf(c.request) === idOf(r)).length,
      myQuote: mine.find((q) => idOf(q.request) === idOf(r)) || null,
    })).sort((a, b) => Number(b.matchesMyCategory) - Number(a.matchesMyCategory));
  }

  async submitQuote(supplierUserId, requestId, { lines, deliveryDays, note, validDays }) {
    const supplier = await Supplier.findOne({ user: supplierUserId, status: "ACTIVE", verificationStatus: "VERIFIED" });
    if (!supplier) throw httpError(403, "Only verified, active suppliers can send quotes.");
    const request = await QuoteRequest.findById(requestId);
    if (!request || !isOpen(request)) throw httpError(409, "This request is no longer open.");
    if (idOf(request.vendor) === idOf(supplierUserId)) throw httpError(400, "You cannot quote on your own request.");
    // The supplier prices each requested item; names and quantities come from the request.
    if (!Array.isArray(lines) || lines.length !== request.lines.length) throw httpError(400, "Price every item in the request.");
    const priced = cleanLines(request.lines.map((l, i) => ({ ...l, unitPrice: lines[i]?.unitPrice })), { priced: true });
    const days = Math.round(Number(deliveryDays));
    if (!Number.isInteger(days) || days < 0 || days > 90) throw httpError(400, "Say how many days delivery takes (0 to 90).");
    const valid = Math.min(Math.max(Math.round(Number(validDays) || 7), 1), 30);
    const fields = {
      lines: priced, totalAmount: priced.reduce((s, l) => s + l.unitPrice * l.units, 0), deliveryDays: days,
      note: String(note || "").trim().slice(0, 1000), validUntil: new Date(Date.now() + valid * 86400000), status: "SUBMITTED",
    };
    let quote = await Quote.findOne({ request: request._id, supplier: supplierUserId });
    const isNew = !quote;
    if (quote && !["SUBMITTED", "WITHDRAWN"].includes(quote.status)) throw httpError(409, "This quote can no longer be changed.");
    if (quote) { Object.assign(quote, fields); await quote.save(); } else quote = await Quote.create({ request: request._id, supplier: supplierUserId, ...fields });
    notify(request.vendor, { type: "ORDER", title: `${isNew ? "New" : "Updated"} quote for ${request.reference}`, message: `${supplier.businessName}: ${rwf(quote.totalAmount)}, delivery in ${days} day${days === 1 ? "" : "s"}.`, link: "/vendor/quotes" });
    return quote;
  }

  async withdrawQuote(supplierUserId, quoteId) {
    const quote = await Quote.findOne({ _id: quoteId, supplier: supplierUserId });
    if (!quote) throw httpError(404, "Quote not found.");
    if (quote.status !== "SUBMITTED") throw httpError(409, "Only quotes waiting for the vendor can be withdrawn.");
    quote.status = "WITHDRAWN";
    await quote.save();
    return quote;
  }

  async listForSupplier(supplierUserId) {
    const quotes = await Quote.find({ supplier: supplierUserId }).sort({ updatedAt: -1 }).limit(100).lean();
    const requests = quotes.length ? await QuoteRequest.find({ _id: { $in: quotes.map((q) => q.request) } }).lean() : [];
    const byId = new Map(requests.map((r) => [idOf(r), r]));
    return quotes.map((q) => ({ ...q, id: idOf(q), request: byId.get(idOf(q.request)) || null }));
  }

  // ─── Worker ──────────────────────────────────────────────────────────────
  async expireRequests() {
    const today = new Date(new Date().setHours(0, 0, 0, 0));
    const stale = await QuoteRequest.find({ status: "OPEN", neededBy: { $lt: today } }).limit(200);
    for (const r of stale) {
      r.status = "EXPIRED";
      await r.save();
      await this.closeQuotes(r, "The needed-by date passed without a quote being accepted.");
      notify(r.vendor, { type: "ORDER", title: `Quote request ${r.reference} expired`, message: "Its needed-by date passed. Post a new request if you still need the goods.", link: "/vendor/quotes" });
    }
    return stale.length;
  }
}

module.exports = new QuoteService();
