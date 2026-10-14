// Seller-controlled affiliate program.
//
// A product can be promoted by affiliates only when its seller has switched the
// program on, and (when the seller picked "selected products") the product is
// one of the chosen ones. The affiliate then earns:
//   MVEC's share (a set % of MVEC's commission on that product, see commission.service)
// + the seller's rate (affiliateRate, paid out of the seller's earnings).
// The seller's rate is frozen on the order item at checkout, so changing it
// later never alters orders already placed.
const Product = require("../models/Product");
const Vendor = require("../models/Vendor");
const commission = require("./commission.service");

const MAX_VENDOR_RATE = 30;
const PROMOTABLE_STATUSES = ["ACTIVE", "OUT_OF_STOCK"];
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const httpError = (status, message) => Object.assign(new Error(message), { statusCode: status });
const idOf = (v) => String(v?._id || v || "");

/** Program settings in API shape. platformPercent: MVEC's part on the seller's default rate. */
const settingsOf = (vendor, platformPercent = 0) => ({
  enabled: Boolean(vendor?.affiliateEnabled),
  ratePercent: Number(vendor?.affiliateRate) || 0,
  scope: vendor?.affiliateScope === "SELECTED" ? "SELECTED" : "ALL",
  platformPercent,
  totalPercent: round2(platformPercent + (Number(vendor?.affiliateRate) || 0)),
  updatedAt: vendor?.affiliateUpdatedAt || null,
});

/**
 * Affiliate terms for products (docs or ids).
 * Returns Map<productId, { eligible, vendorRate, totalPercent, reason }>.
 */
async function termsFor(productsOrIds) {
  const list = (productsOrIds || []).filter(Boolean);
  const complete = (p) => typeof p === "object" && p.affiliateEnabled !== undefined && p.vendor && p.status !== undefined && p.category !== undefined;
  const needLoad = list.filter((p) => !complete(p));
  const loaded = needLoad.length
    ? await Product.find({ _id: { $in: needLoad.map(idOf) } }).select("vendor status affiliateEnabled category")
    : [];
  const byId = new Map(loaded.map((p) => [idOf(p), p]));
  const products = list.map((p) => (complete(p) ? p : byId.get(idOf(p)))).filter(Boolean);

  const vendorIds = [...new Set(products.map((p) => idOf(p.vendor)))];
  const vendors = vendorIds.length ? await Vendor.find({ user: { $in: vendorIds } }).select("user affiliateEnabled affiliateRate affiliateScope") : [];
  const vendorByUser = new Map(vendors.map((v) => [idOf(v.user), v]));

  const out = new Map();
  for (const p of products) {
    const v = vendorByUser.get(idOf(p.vendor));
    let reason = null;
    if (!PROMOTABLE_STATUSES.includes(p.status)) reason = "This product is not for sale right now.";
    else if (!v || !v.affiliateEnabled) reason = "The seller is not running an affiliate program.";
    else if (v.affiliateScope === "SELECTED" && !p.affiliateEnabled) reason = "The seller has not opened this product to affiliates.";
    const vendorRate = reason ? 0 : Number(v.affiliateRate) || 0;
    const mvec = reason ? 0 : await commission.platformAffiliatePercent({ vendorId: p.vendor, categoryId: p.category });
    out.set(idOf(p), { eligible: !reason, vendorRate, platformPercent: mvec, totalPercent: round2(mvec + vendorRate), reason });
  }
  return out;
}

async function termsForOne(productOrId) {
  return (await termsFor([productOrId])).get(idOf(productOrId)) || { eligible: false, vendorRate: 0, totalPercent: 0, reason: "Product not found." };
}

async function getVendorProgram(vendorUserId) {
  const vendor = await Vendor.findOne({ user: vendorUserId });
  if (!vendor) throw httpError(404, "Complete your store profile (onboarding) before setting up the affiliate program.");
  const selected = await Product.find({ vendor: vendorUserId, affiliateEnabled: true }).select("_id");
  const platformPercent = await commission.platformAffiliatePercent({ vendorId: vendorUserId, categoryId: null });
  return { ...settingsOf(vendor, platformPercent), selectedProductIds: selected.map((p) => idOf(p)) };
}

/**
 * Update the seller's program. productIds (for scope SELECTED) replaces the
 * chosen list; only the seller's own products can be chosen.
 */
async function updateVendorProgram(vendorUserId, { enabled, ratePercent, scope, productIds } = {}) {
  const vendor = await Vendor.findOne({ user: vendorUserId });
  if (!vendor) throw httpError(404, "Complete your store profile (onboarding) before setting up the affiliate program.");

  if (enabled !== undefined) vendor.affiliateEnabled = Boolean(enabled);
  if (ratePercent !== undefined) {
    const rate = Number(ratePercent);
    if (!Number.isFinite(rate) || rate < 0 || rate > MAX_VENDOR_RATE) {
      throw httpError(400, `Choose a commission between 0% and ${MAX_VENDOR_RATE}%.`);
    }
    vendor.affiliateRate = round2(rate);
  }
  if (scope !== undefined) {
    if (!["ALL", "SELECTED"].includes(scope)) throw httpError(400, "Choose all products or selected products.");
    vendor.affiliateScope = scope;
  }
  if (Array.isArray(productIds)) {
    const ids = [...new Set(productIds.map(String))];
    const own = ids.length ? await Product.find({ _id: { $in: ids }, vendor: vendorUserId }).select("_id") : [];
    if (own.length !== ids.length) throw httpError(400, "You can only choose your own products.");
    await Product.updateMany({ vendor: vendorUserId, affiliateEnabled: true, _id: { $nin: ids } }, { $set: { affiliateEnabled: false } });
    if (ids.length) await Product.updateMany({ _id: { $in: ids } }, { $set: { affiliateEnabled: true } });
  }
  if (vendor.affiliateEnabled && vendor.affiliateScope === "SELECTED" && !(await Product.exists({ vendor: vendorUserId, affiliateEnabled: true }))) {
    throw httpError(400, "Choose at least one product, or open all your products to affiliates.");
  }
  vendor.affiliateUpdatedAt = new Date();
  await vendor.save();
  return getVendorProgram(vendorUserId);
}

/** Program results for the seller: links, clicks, orders and commission on their products. */
async function vendorProgramStats(vendorUserId) {
  const AffiliateLink = require("../models/AffiliateLink");
  const AffiliateClick = require("../models/AffiliateClick");
  const ConversionAudit = require("../models/ConversionAudit");
  const Settlement = require("../models/Settlement");
  const products = await Product.find({ vendor: vendorUserId }).select("_id");
  const ids = products.map((p) => p._id);
  if (!ids.length) return { activeLinks: 0, affiliates: 0, clicks: 0, orders: 0, sales: 0, commission: 0, paidByYou: 0 };
  const [links, clicks, conversions, settlements] = await Promise.all([
    AffiliateLink.find({ targetProduct: { $in: ids }, status: { $ne: "TERMINATED" } }).select("affiliateUser"),
    AffiliateClick.countDocuments({ product: { $in: ids } }),
    ConversionAudit.find({ targetProduct: { $in: ids }, status: { $ne: "REJECTED" } }).select("conversionValue commissionEarned reversedAmount order"),
    Settlement.find({ vendor: vendorUserId, vendorAffiliateShare: { $gt: 0 }, status: { $in: ["HELD", "RELEASED"] } }).select("vendorAffiliateShare"),
  ]);
  return {
    activeLinks: links.length,
    affiliates: new Set(links.map((l) => idOf(l.affiliateUser))).size,
    clicks,
    orders: new Set(conversions.map((c) => idOf(c.order))).size,
    sales: round2(conversions.reduce((s, c) => s + (Number(c.conversionValue) || 0), 0)),
    commission: round2(conversions.reduce((s, c) => s + (Number(c.commissionEarned) || 0) - (Number(c.reversedAmount) || 0), 0)),
    paidByYou: round2(settlements.reduce((s, x) => s + (Number(x.vendorAffiliateShare) || 0), 0)),
  };
}

module.exports = { MAX_VENDOR_RATE, settingsOf, termsFor, termsForOne, getVendorProgram, updateVendorProgram, vendorProgramStats };
