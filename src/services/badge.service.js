// Seller badges, earned from real numbers (as Alibaba's "Verified" and
// Jumia's "Top seller"), never set by hand:
//
//   VERIFIED     Ikiguzi checked the seller's identity and business papers
//   TOP_RATED    4.5 stars or more over at least 5 reviews
//   FAST_SHIPPER half or more of the last 20 delivered orders were ready within 24 hours of payment (5 at least)
//   NEW_SELLER   joined in the last 30 days
//
// Computed on read and cached for 10 minutes per seller.
const Vendor = require("../models/Vendor");
const Supplier = require("../models/Supplier");
const Product = require("../models/Product");
const Review = require("../models/Review");
const Settlement = require("../models/Settlement");
const Order = require("../models/Order");
const Delivery = require("../models/Delivery");

const LABELS = {
  VERIFIED: { label: "Verified seller", hint: "Ikiguzi checked this seller's ID and business registration." },
  TOP_RATED: { label: "Top rated", hint: "Rated 4.5 stars or more by buyers." },
  FAST_SHIPPER: { label: "Ships fast", hint: "Usually has orders ready within 24 hours." },
  NEW_SELLER: { label: "New seller", hint: "Joined Ikiguzi this month." },
};
const TTL_MS = 10 * 60 * 1000;
const cache = new Map();
const HOUR = 3600 * 1000;

async function rating(sellerId) {
  const products = await Product.find({ vendor: sellerId }).select("_id").lean();
  if (!products.length) return { avg: 0, count: 0 };
  const reviews = await Review.find({ product: { $in: products.map((p) => p._id) }, status: "PUBLISHED" }).select("rating").lean();
  const count = reviews.length;
  return { avg: count ? reviews.reduce((n, r) => n + Number(r.rating || 0), 0) / count : 0, count };
}

/** Hours from payment to ready (rider parcels) or shipped, for the seller's last 20 delivered orders. */
async function readyHours(sellerId) {
  const released = await Settlement.find({ vendor: sellerId, status: "RELEASED" }).select("order releasedAt").sort({ releasedAt: -1 }).limit(60).lean();
  const orderIds = [...new Set(released.map((s) => String(s.order)))].slice(0, 20);
  if (!orderIds.length) return [];
  const [orders, deliveries] = await Promise.all([
    Order.find({ _id: { $in: orderIds } }).select("paidAt shippedAt").lean(),
    Delivery.find({ order: { $in: orderIds }, vendor: sellerId }).select("order readyAt").lean(),
  ]);
  const readyAt = new Map(deliveries.map((d) => [String(d.order), d.readyAt]));
  return orders
    .map((o) => {
      const done = readyAt.get(String(o._id)) || o.shippedAt;
      return o.paidAt && done ? (new Date(done) - new Date(o.paidAt)) / HOUR : null;
    })
    .filter((h) => h !== null && h >= 0);
}

async function compute(sellerId) {
  const [vendor, supplier] = await Promise.all([
    Vendor.findOne({ user: sellerId }).select("verificationStatus createdAt").lean(),
    Supplier.findOne({ user: sellerId }).select("verificationStatus createdAt").lean(),
  ]);
  const profile = vendor || supplier;
  if (!profile) return [];
  const earned = [];
  if (profile.verificationStatus === "VERIFIED") earned.push("VERIFIED");
  const r = await rating(sellerId);
  if (r.count >= 5 && r.avg >= 4.5) earned.push("TOP_RATED");
  const hours = await readyHours(sellerId);
  if (hours.length >= 5 && hours.filter((h) => h <= 24).length >= hours.length / 2) earned.push("FAST_SHIPPER");
  if (profile.createdAt && Date.now() - new Date(profile.createdAt) < 30 * 24 * HOUR) earned.push("NEW_SELLER");
  return earned.map((code) => ({ code, ...LABELS[code] }));
}

/** [{ code, label, hint }] for a seller (user id). */
async function forSeller(sellerId) {
  const id = String(sellerId || "");
  if (!id) return [];
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.badges;
  const badges = await compute(id).catch(() => []);
  cache.set(id, { badges, at: Date.now() });
  if (cache.size > 5000) cache.delete(cache.keys().next().value);
  return badges;
}

const clear = (sellerId) => (sellerId ? cache.delete(String(sellerId)) : cache.clear());

module.exports = { forSeller, clear, LABELS };
