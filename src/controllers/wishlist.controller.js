// The signed-in account's saved products (/api/auth/wishlist).
const orm = require("../database/orm");
const User = require("../models/User");
const Product = require("../models/Product");
const { effectivePrice } = require("../utils/pricing.util");

const WISHLIST_MAX = 200;

async function wishlistResponse(userId) {
  const user = await User.findById(userId).select("wishlist").populate({
    path: "wishlist.product",
    select: "name price discountPrice media stockQuantity status vendor category",
    populate: [{ path: "vendor", select: "Fullname companyName" }, { path: "category", select: "name" }],
  });
  // Products that were deleted drop out of the list.
  return (user?.wishlist || []).filter((w) => w.product).map((w) => ({
    product: w.product,
    savedPrice: w.savedPrice,
    savedAt: w.savedAt,
  }));
}

// @route GET /api/auth/wishlist
exports.getWishlist = async (req, res) => {
  try {
    return res.status(200).json({ items: await wishlistResponse(req.user.id) });
  } catch (error) {
    console.error("Wishlist load failed:", error);
    return res.status(500).json({ message: "Could not load your wishlist." });
  }
};

// @route POST /api/auth/wishlist   { productIds: [...] }  (adds; used to merge device lists too)
exports.addToWishlist = async (req, res) => {
  try {
    const ids = [...new Set((Array.isArray(req.body.productIds) ? req.body.productIds : [req.body.productId]).map(String))]
      .filter((id) => orm.isValidObjectId(id))
      .slice(0, WISHLIST_MAX);
    if (!ids.length) return res.status(400).json({ message: "Choose a product to save." });

    const products = await Product.find({ _id: { $in: ids }, status: { $in: ["ACTIVE", "OUT_OF_STOCK"] } }).select(require("../utils/pricing.util").PRICE_FIELDS);
    const user = await User.findById(req.user.id).select("wishlist");
    const have = new Set(user.wishlist.map((w) => String(w.product)));
    for (const p of products) {
      if (!have.has(String(p._id)) && user.wishlist.length < WISHLIST_MAX) {
        user.wishlist.push({ product: p._id, savedPrice: effectivePrice(p), savedAt: new Date() });
      }
    }
    await user.save({ validateBeforeSave: false });
    // A saved product's price is watched: the buyer hears when it drops.
    for (const p of products) await require("../services/alerts.service").subscribe(req.user, p._id, "PRICE_DROP").catch(() => {});
    return res.status(200).json({ items: await wishlistResponse(req.user.id) });
  } catch (error) {
    console.error("Wishlist add failed:", error);
    return res.status(500).json({ message: "Could not save this product." });
  }
};

// @route DELETE /api/auth/wishlist/:productId
exports.removeFromWishlist = async (req, res) => {
  try {
    if (!orm.isValidObjectId(req.params.productId)) return res.status(404).json({ message: "Product not in your wishlist." });
    await User.updateOne({ _id: req.user.id }, { $pull: { wishlist: { product: req.params.productId } } });
    await require("../services/alerts.service").unsubscribe(req.user, req.params.productId, "PRICE_DROP").catch(() => {});
    return res.status(200).json({ items: await wishlistResponse(req.user.id) });
  } catch (error) {
    console.error("Wishlist remove failed:", error);
    return res.status(500).json({ message: "Could not remove this product." });
  }
};
