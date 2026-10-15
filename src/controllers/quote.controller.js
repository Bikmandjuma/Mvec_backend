// Quote requests (vendors ask, suppliers quote). Rules live in services/quote.service.js.
const quotes = require("../services/quote.service");
const QuoteRequest = require("../models/QuoteRequest");
const { supplierOwnerOf, vendorOwnerOf } = require("../utils/accountOwner.util");

const fail = (res, error) => res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Something went wrong. Please try again." });
const supplierOwner = async (req) => {
  const owner = await supplierOwnerOf(req.user);
  if (!owner) throw Object.assign(new Error("Complete your supplier profile first."), { statusCode: 403 });
  return owner;
};

// Vendor
exports.createRequest = async (req, res) => {
  try {
    const { request, suppliersNotified } = await quotes.createRequest(vendorOwnerOf(req), req.body || {});
    return res.status(201).json({ message: `Request sent to ${suppliersNotified} supplier${suppliersNotified === 1 ? "" : "s"}. You will be notified when quotes arrive.`, request });
  } catch (error) { return fail(res, error); }
};
exports.myRequests = async (req, res) => {
  try { return res.json({ requests: await quotes.listForVendor(vendorOwnerOf(req)) }); } catch (error) { return fail(res, error); }
};
exports.cancelRequest = async (req, res) => {
  try { return res.json({ message: "Request cancelled. Suppliers who quoted were told.", request: await quotes.cancelRequest(vendorOwnerOf(req), req.params.id) }); } catch (error) { return fail(res, error); }
};
exports.acceptQuote = async (req, res) => {
  try {
    const { order } = await quotes.acceptQuote(vendorOwnerOf(req), req.params.quoteId);
    return res.json({ message: `Quote accepted. Order ${order.orderNumber} is ready to pay in Purchases.`, order });
  } catch (error) { return fail(res, error); }
};

// Supplier
exports.openRequests = async (req, res) => {
  try {
    const owner = await supplierOwner(req);
    return res.json({ requests: await quotes.listOpenForSupplier(owner.userId, owner.supplier.category) });
  } catch (error) { return fail(res, error); }
};
exports.submitQuote = async (req, res) => {
  try {
    const owner = await supplierOwner(req);
    return res.json({ message: "Quote sent. The vendor was notified.", quote: await quotes.submitQuote(owner.userId, req.params.id, req.body || {}) });
  } catch (error) { return fail(res, error); }
};
exports.withdrawQuote = async (req, res) => {
  try {
    const owner = await supplierOwner(req);
    return res.json({ message: "Quote withdrawn.", quote: await quotes.withdrawQuote(owner.userId, req.params.quoteId) });
  } catch (error) { return fail(res, error); }
};
exports.myQuotes = async (req, res) => {
  try {
    const owner = await supplierOwner(req);
    return res.json({ quotes: await quotes.listForSupplier(owner.userId) });
  } catch (error) { return fail(res, error); }
};

// Admin oversight (read-only)
exports.adminList = async (req, res) => {
  try {
    const requests = await QuoteRequest.find(req.query.status ? { status: String(req.query.status).toUpperCase() } : {})
      .populate("vendor", "Fullname companyName").sort({ createdAt: -1 }).limit(100).lean();
    const Quote = require("../models/Quote");
    const counts = requests.length ? await Quote.find({ request: { $in: requests.map((r) => r._id) }, status: { $ne: "WITHDRAWN" } }).select("request").lean() : [];
    return res.json({ requests: requests.map((r) => ({ ...r, id: String(r._id), quoteCount: counts.filter((c) => String(c.request) === String(r._id)).length })) });
  } catch (error) { return fail(res, error); }
};
