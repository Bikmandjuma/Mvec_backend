// A seller works fully from sign-up: they add products, stock, stores and
// prices. Buyers see those products only once Ikiguzi has approved the seller
// (Vendor or Supplier verificationStatus VERIFIED). Until then a product the
// seller wants live waits as PENDING_APPROVAL, which no buyer-facing query
// shows. The admin's VERIFIED decision puts them live; a later rejection takes
// them back off. Drafts and products the seller hid stay as the seller left them.
const Product = require("../models/Product");
const Vendor = require("../models/Vendor");
const Supplier = require("../models/Supplier");
const User = require("../models/User");

const PENDING = "PENDING_APPROVAL";
const LIVE = ["ACTIVE", "OUT_OF_STOCK"];
const idOf = (v) => String(v?._id || v?.id || v || "");

/** Whether buyers may see this seller's products. `sellerId` is the seller's user id. */
async function sellerApproved(sellerId) {
  const id = idOf(sellerId);
  if (!id) return false;
  const [vendor, supplier] = await Promise.all([
    Vendor.findOne({ user: id }).select("verificationStatus").lean(),
    Supplier.findOne({ user: id }).select("verificationStatus").lean(),
  ]);
  if (vendor || supplier) return vendor?.verificationStatus === "VERIFIED" || supplier?.verificationStatus === "VERIFIED";
  // Ikiguzi's own listings (an admin selling) need no approval.
  const user = await User.findById(id).select("role").lean();
  return user?.role === "super_admin";
}

/** The status to store: a status that would put the product live waits for approval instead. */
function statusFor(approved, status) {
  return !approved && LIVE.includes(status) ? PENDING : status;
}

/** Admin approved the seller: their waiting products go live. */
async function release(sellerId) {
  const vendor = idOf(sellerId);
  const [inStock, empty] = await Promise.all([
    Product.updateMany({ vendor, status: PENDING, stockQuantity: { $gt: 0 } }, { $set: { status: "ACTIVE" } }),
    Product.updateMany({ vendor, status: PENDING, stockQuantity: { $lte: 0 } }, { $set: { status: "OUT_OF_STOCK" } }),
  ]);
  return (inStock?.modifiedCount || 0) + (empty?.modifiedCount || 0);
}

/** Admin rejected the seller: their live products wait again until approval. */
async function hold(sellerId) {
  const res = await Product.updateMany({ vendor: idOf(sellerId), status: { $in: LIVE } }, { $set: { status: PENDING } });
  return res?.modifiedCount || 0;
}

/** Follows an admin's verification decision. */
const followDecision = (sellerId, decision) => (decision === "VERIFIED" ? release(sellerId) : hold(sellerId));

module.exports = { PENDING, sellerApproved, statusFor, release, hold, followDecision };
