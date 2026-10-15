const orm = require("../database/orm");
const Promotion = require("../models/Promotion");
const Product = require("../models/Product");
const { resolveOwnedStore } = require("../utils/vendorStore.util");
const promotionService = require("../services/promotion.service");
const shippingService = require("../services/shipping.service");

function mapPromotion(p, stats) {
  return {
    id: p.publicId || p._id,
    name: p.name,
    code: p.code,
    type: p.type,
    value: p.value,
    // Present discount as display text for the frontend table
    discount:
      p.type === "PERCENT"
        ? `${p.value}%`
        : p.type === "FIXED"
        ? `${Number(p.value).toLocaleString("en-RW")} RWF`
        : "Free shipping",
    status: p.status,
    // What buyers experience now (dates and usage limit applied).
    liveStatus: promotionService.effectiveStatus(p),
    stats: stats || undefined,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
    usageLimit: p.usageLimit,
    usedCount: p.usedCount,
    minOrderAmount: p.minOrderAmount,
    createdBy: p.createdBy,
    store: p.store,
    vendor: p.vendor,
    product: p.product,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

// The list endpoint exposes publicId as `id`, so accept either identifier.
const findPromotion = (id) =>
  orm.isValidObjectId(id) ? Promotion.findById(id) : Promotion.findOne({ publicId: id });

const allowedStatus = ["DRAFT", "SCHEDULED", "ACTIVE", "PAUSED", "EXPIRED", "CANCELLED"];
const allowedType = ["PERCENT", "FIXED", "FREE_SHIPPING"];

// Shared checks for create and update; returns an error message or null.
function invalidPromotion({ type, value, startsAt, endsAt, usageLimit, minOrderAmount }) {
  const v = Number(value);
  if (type === "PERCENT" && (!(v > 0) || v > 100)) return "A percentage discount must be between 1 and 100.";
  if (type === "FIXED" && !(v > 0)) return "Enter the amount off in RWF.";
  if (startsAt && endsAt && new Date(endsAt) < new Date(startsAt)) return "The end date must be on or after the start date.";
  if (usageLimit != null && usageLimit !== "" && !(Number(usageLimit) >= 1)) return "The usage limit must be at least 1, or empty for unlimited.";
  if (minOrderAmount != null && Number(minOrderAmount) < 0) return "The minimum order can't be negative.";
  return null;
}

// @desc    Check a coupon against a basket (checkout preview)
// @route   POST /api/promotions/validate  { code, items:[{productId, qty}], shippingAddress?, shippingMethod? }
// @access  Private
exports.validateCoupon = async (req, res) => {
  try {
    const { code, items = [], shippingAddress, shippingMethod } = req.body;
    const ids = items.map((i) => i.productId).filter((id) => orm.isValidObjectId(id));
    const products = await Product.find({ _id: { $in: ids } });
    const byId = new Map(products.map((p) => [String(p._id), p]));
    const lines = items
      .map((i) => ({ product: byId.get(String(i.productId)), quantity: Number(i.qty || i.quantity) || 1 }))
      .filter((l) => l.product)
      .map((l) => ({ ...l, price: l.product.discountPrice || l.product.price }));
    if (!lines.length) return res.status(400).json({ message: "Your basket is empty." });

    let parcels = [];
    if (shippingAddress) {
      const quote = await shippingService.quoteShipping({ lines, address: shippingAddress, method: shippingMethod }).catch(() => null);
      parcels = quote?.groups?.map((g) => ({ vendor: g.vendor, store: g.store, fee: g.fee })) || [];
    }
    const q = await promotionService.quote(code, { lines, parcels, userId: req.user.id });
    return res.status(200).json({
      code: q.code, name: q.name, type: q.type,
      itemDiscount: q.itemDiscount, shippingDiscount: q.shippingDiscount, discount: q.discount,
      message: q.message,
    });
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.status ? error.message : "Could not check this code." });
  }
};

// @desc    Create a promotion (vendor for their store, or admin with scope)
// @route   POST /api/promotions
// @access  Private (vendor or super_admin)
exports.createPromotion = async (req, res) => {
  try {
    const {
      name,
      code,
      type,
      value,
      product,
      category,
      startsAt,
      endsAt,
      status,
      usageLimit,
      minOrderAmount,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Promotion name is required" });
    }
    if (!code || !code.trim()) {
      return res.status(400).json({ message: "Promotion code is required" });
    }

    const promoType = type || "PERCENT";
    if (!allowedType.includes(promoType)) {
      return res.status(400).json({ message: "Invalid promotion type" });
    }
    const invalid = invalidPromotion({ type: promoType, value, startsAt, endsAt, usageLimit, minOrderAmount });
    if (invalid) return res.status(400).json({ message: invalid });

    const existing = await Promotion.findOne({ code: String(code).trim().toUpperCase() });
    if (existing) {
      return res.status(409).json({ message: "A promotion with this code already exists" });
    }

    const isVendor = req.user.role === "vendor";
    if (product) {
      if (!orm.isValidObjectId(product)) return res.status(400).json({ message: "Invalid product" });
      const owned = await Product.exists(isVendor ? { _id: product, vendor: req.user._id } : { _id: product });
      if (!owned) return res.status(400).json({ message: "Choose one of your own products." });
    }
    let store = null;
    if (isVendor) {
      store = await resolveOwnedStore(req.user._id, req.body.storeId);
      if (!store && req.body.storeId) {
        return res.status(400).json({ message: "Select one of your own stores." });
      }
      if (!store && !product) {
        return res.status(400).json({ message: "Create a store before adding promotions" });
      }
    }

    const promotion = await Promotion.create({
      name: name.trim(),
      code: String(code).trim().toUpperCase(),
      type: promoType,
      value: value || 0,
      vendor: isVendor ? req.user._id : null,
      store: isVendor ? (store ? store._id : null) : null,
      product: product || null,
      category: category || null,
      startsAt: startsAt || null,
      endsAt: endsAt || null,
      status: status || "DRAFT",
      usageLimit: usageLimit || null,
      minOrderAmount: minOrderAmount || 0,
      createdBy: req.user._id,
    });

    return res.status(201).json({
      message: promotion.status === "ACTIVE" ? `Promotion created. Buyers can use ${promotion.code} now.` : "Promotion created",
      promotion: mapPromotion(promotion.toObject()),
    });
  } catch (error) {
    console.error("Error creating promotion:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// @desc    List promotions (vendor sees own, admin sees all)
// @route   GET /api/promotions
// @access  Private
exports.listPromotions = async (req, res) => {
  try {
    const { status } = req.query;
    const query = {};
    if (req.user.role === "vendor") {
      query.vendor = req.user._id;
    }
    if (status) query.status = status;

    const promotions = await Promotion.find(query).sort({ createdAt: -1 });
    const stats = await promotionService.stats(promotions.map((p) => p._id));
    const empty = { orders: 0, paidOrders: 0, discountGiven: 0, sales: 0 };
    return res.status(200).json({
      data: promotions.map((p) => mapPromotion(p.toObject(), stats.get(String(p._id)) || empty)),
      meta: { total: promotions.length },
    });
  } catch (error) {
    console.error("Error listing promotions:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// @desc    Update a promotion
// @route   PATCH /api/promotions/:id
// @access  Private (vendor owner or super_admin)
exports.updatePromotion = async (req, res) => {
  try {
    const { id } = req.params;
    const promotion = await findPromotion(id);
    if (!promotion) {
      return res.status(404).json({ message: "Promotion not found" });
    }

    const isOwner = req.user.role === "vendor" && String(promotion.vendor) === String(req.user._id);
    const isAdmin = req.user.role === "super_admin";
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: "Not authorized to update this promotion" });
    }

    const { name, code, type, value, status, startsAt, endsAt, usageLimit, minOrderAmount } =
      req.body;

    if (name !== undefined && name.trim()) promotion.name = name.trim();
    if (code !== undefined && code.trim()) {
      const nextCode = String(code).trim().toUpperCase();
      if (nextCode !== promotion.code) {
        const exists = await Promotion.findOne({ code: nextCode, _id: { $ne: promotion._id } });
        if (exists) {
          return res.status(409).json({ message: "A promotion with this code already exists" });
        }
        promotion.code = nextCode;
      }
    }
    if (type !== undefined) {
      if (!allowedType.includes(type)) {
        return res.status(400).json({ message: "Invalid promotion type" });
      }
      promotion.type = type;
    }
    if (value !== undefined) promotion.value = value;
    if (status !== undefined) {
      if (!allowedStatus.includes(status)) {
        return res.status(400).json({ message: "Invalid promotion status" });
      }
      promotion.status = status;
    }
    const invalid = invalidPromotion({
      type: promotion.type,
      value: promotion.value,
      startsAt: startsAt !== undefined ? startsAt : promotion.startsAt,
      endsAt: endsAt !== undefined ? endsAt : promotion.endsAt,
      usageLimit, minOrderAmount,
    });
    if (invalid) return res.status(400).json({ message: invalid });
    if (startsAt !== undefined) promotion.startsAt = startsAt;
    if (endsAt !== undefined) promotion.endsAt = endsAt;
    if (usageLimit !== undefined) promotion.usageLimit = usageLimit;
    if (minOrderAmount !== undefined) promotion.minOrderAmount = minOrderAmount;

    await promotion.save();
    return res.status(200).json({
      message: "Promotion updated",
      promotion: mapPromotion(promotion.toObject()),
    });
  } catch (error) {
    console.error("Error updating promotion:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// @desc    Delete a promotion
// @route   DELETE /api/promotions/:id
// @access  Private (vendor owner or super_admin)
exports.deletePromotion = async (req, res) => {
  try {
    const { id } = req.params;
    const promotion = await findPromotion(id);
    if (!promotion) {
      return res.status(404).json({ message: "Promotion not found" });
    }

    const isOwner = req.user.role === "vendor" && String(promotion.vendor) === String(req.user._id);
    const isAdmin = req.user.role === "super_admin";
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: "Not authorized to delete this promotion" });
    }

    await Promotion.deleteOne({ _id: promotion._id });
    return res.status(200).json({ message: "Promotion deleted" });
  } catch (error) {
    console.error("Error deleting promotion:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};