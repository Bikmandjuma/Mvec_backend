const orm = require("../database/orm");
const Supplier = require("../models/Supplier");
const SupplierTeamMember = require("../models/SupplierTeamMember");
const Product = require("../models/Product");
const WholesaleProduct = require("../models/WholesaleProduct");
const StockMovement = require("../models/StockMovement");
const stock = require("../services/stock.service");
const supplierStores = require("../services/supplierStore.service");
const supplierRetail = require("../services/supplierRetail.service");

// Resolve the signed-in supplier's profile document (used by wholesale CRUD).
async function resolveMySupplier(userId) {
  let supplier = await Supplier.findOne({ user: userId });
  if (!supplier) {
    const membership = await SupplierTeamMember.findOne({ user: userId, status: "ACTIVE" });
    if (membership) supplier = await Supplier.findById(membership.supplier);
  }
  if (!supplier) {
    const error = new Error("Supplier profile not found. Please complete onboarding.");
    error.status = 404;
    throw error;
  }
  return supplier;
}

// Normalize the numeric + media fields of a wholesale product payload.
function sanitizeWholesalePayload(body = {}, defaults = {}) {
  return {
    name: body.name !== undefined ? body.name : defaults.name,
    shortDescription: body.shortDescription !== undefined ? body.shortDescription : defaults.shortDescription,
    category: body.category !== undefined && body.category !== "" ? body.category : defaults.category || "General",
    unit: body.unit !== undefined && body.unit !== "" ? body.unit : defaults.unit || "piece",
    wholesalePrice: Math.max(0, Number(body.wholesalePrice ?? defaults.wholesalePrice ?? 0) || 0),
    retailPrice: Math.max(0, Number(body.retailPrice ?? defaults.retailPrice ?? 0) || 0),
    moq: Math.max(1, Number(body.moq ?? defaults.moq ?? 1) || 1),
    stockQuantity: Math.max(0, Number(body.stockQuantity ?? defaults.stockQuantity ?? 0) || 0),
    lowStockThreshold: Math.max(0, Math.floor(Number(body.lowStockThreshold ?? defaults.lowStockThreshold ?? 10) || 0)),
    bulkDiscount: Math.min(100, Math.max(0, Number(body.bulkDiscount ?? defaults.bulkDiscount ?? 0) || 0)),
    media: body.media !== undefined ? body.media : defaults.media || { mainImage: "", gallery: [] },
    // Suppliers choose Active or Archived; Out of stock is set from the stock count.
    ...(["ACTIVE", "ARCHIVED"].includes(body.status) ? { status: body.status } : {}),
  };
}

// The store a product is stocked in, from body.storeId: undefined = unchanged,
// empty = the primary store, otherwise one of the supplier's own stores.
async function storeFromBody(supplier, body = {}) {
  const raw = body.storeId !== undefined ? body.storeId : body.store;
  const storeId = raw && typeof raw === "object" ? raw._id : raw;
  if (storeId === undefined) return {};
  if (storeId === null || storeId === "") return { store: null };
  const store = await supplierStores.resolveOwnedStore(supplier, storeId);
  if (!store) throw Object.assign(new Error("Select one of your own stores."), { status: 400 });
  return { store: store._id };
}

// ─── 1. ONBOARD SUPPLIER (complete profile after registering) ──────────────
// @route   POST /api/suppliers/onboard
// @access  Private (role: "supplier")
exports.onboardSupplier = async (req, res) => {
  try {
    if (req.user.role !== "supplier") {
      return res.status(403).json({ message: "Only supplier accounts can create a supplier profile" });
    }

    const existing = await Supplier.findOne({ user: req.user.id });
    const created = !existing;
    const { businessName, description, phone, email, logoUrl, category, location } = req.body;

    if (!businessName || !phone || !email || !description || !logoUrl || !category || !location) {
      return res.status(400).json({ message: "Business name, phone, email, description, logo, category, and location are required." });
    }

    const supplier = existing || new Supplier({ user: req.user.id });
    Object.assign(supplier, { businessName, description, phone, email, logoUrl, category, location, verificationStatus: "PENDING", verificationNote: "" });
    await supplier.save();
    require("../services/notification.service").profileSubmitted({ kind: "supplier", name: businessName, resubmitted: !created }).catch(() => {});
    await require("../models/User").findByIdAndUpdate(req.user.id, { companyName: businessName, businessName, description, logoUrl, category, location, isOnboarded: true, verificationStatus: "PENDING" });

    return res.status(created ? 201 : 200).json({ message: created ? "Supplier profile created" : "Supplier profile updated", supplier });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "A supplier with this business name already exists" });
    }
    return res.status(400).json({ message: error.message });
  }
};

// ─── 2. GET OWN SUPPLIER PROFILE ────────────────────────────────────────────
// @route   GET /api/supplier/profile
// @access  Private (role: "supplier")
exports.getMyProfile = async (req, res) => {
  try {
    const supplier = await Supplier.findOne({ user: req.user.id });
    if (!supplier) {
      return res.status(404).json({ message: "Supplier profile not found. Please complete onboarding." });
    }
    return res.status(200).json({ supplier });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── 3. UPDATE OWN SUPPLIER PROFILE ─────────────────────────────────────────
// @route   PATCH /api/supplier/profile
// @access  Private (role: "supplier", own profile only)
exports.updateMyProfile = async (req, res) => {
  try {
    const supplier = await Supplier.findOne({ user: req.user.id });
    if (!supplier) {
      return res.status(404).json({ message: "Supplier profile not found. Please complete onboarding." });
    }

    const { businessName, description, phone, email, logoUrl, location, category } = req.body;

    // Fields the supplier is allowed to self-edit — NOT verificationStatus, ratingAvg, or status
    if (businessName !== undefined) supplier.businessName = businessName;
    if (description !== undefined) supplier.description = description;
    if (phone !== undefined) supplier.phone = phone;
    if (email !== undefined) supplier.email = email;
    if (logoUrl !== undefined) supplier.logoUrl = logoUrl;
    if (location !== undefined) supplier.location = location;
    if (category !== undefined) supplier.category = category;

    // A rejected profile that has been fixed goes straight back to MVEC for review.
    const resubmitted = supplier.verificationStatus === "REJECTED";
    if (resubmitted) {
      supplier.verificationStatus = "PENDING";
      supplier.verificationNote = "";
    }
    await supplier.save();
    if (resubmitted) {
      await require("../models/User").findByIdAndUpdate(supplier.user, { verificationStatus: "PENDING" });
      require("../services/notification.service").profileSubmitted({ kind: "supplier", name: supplier.businessName, resubmitted: true }).catch(() => {});
    }
    return res.status(200).json({ message: resubmitted ? "Profile saved and sent to MVEC for review again." : "Supplier profile updated", supplier });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "A supplier with this business name already exists" });
    }
    return res.status(400).json({ message: error.message });
  }
};

// ─── 4. PUBLIC SUPPLIER DIRECTORY ───────────────────────────────────────────
// @route   GET /api/suppliers?q=&category=&location=&page=&pageSize=
// @access  Public
// Public supplier shape: contact details and internal review notes stay private.
const toPublicSupplier = (doc) => {
  const s = doc && doc.toJSON ? doc.toJSON() : { ...doc };
  delete s.phone;
  delete s.email;
  delete s.verificationNote;
  return s;
};
const escapeSupplierRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

exports.getSuppliers = async (req, res) => {
  try {
    const { q, location, page = 1, pageSize = 20 } = req.query;

    const filter = {
      status: "ACTIVE",
      verificationStatus: "VERIFIED", // only show verified suppliers publicly
    };

    if (q) {
      filter.businessName = { $regex: escapeSupplierRegex(String(q).slice(0, 100)), $options: "i" };
    }
    if (location) {
      filter.location = location;
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limit = Math.min(parseInt(pageSize, 10) || 20, 100); // cap page size
    const skip = (pageNum - 1) * limit;

    const [suppliers, total] = await Promise.all([
      Supplier.find(filter).sort({ ratingAvg: -1 }).skip(skip).limit(limit),
      Supplier.countDocuments(filter),
    ]);

    return res.status(200).json({
      data: suppliers.map(toPublicSupplier),
      meta: { page: pageNum, pageSize: limit, total },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── 5. PUBLIC SUPPLIER STOREFRONT (by id or slug) ─────────────────────────
// @route   GET /api/suppliers/:idOrSlug
// @access  Public
exports.getSupplierByIdOrSlug = async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const isObjectId = idOrSlug.match(/^[0-9a-fA-F]{24}$/);

    const query = isObjectId
      ? { _id: idOrSlug }
      : { slug: idOrSlug };

    const supplier = await Supplier.findOne({
      ...query,
      status: "ACTIVE",
      verificationStatus: "VERIFIED",
    });

    if (!supplier) {
      return res.status(404).json({ message: "Supplier not found" });
    }

    return res.status(200).json({ supplier: toPublicSupplier(supplier) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── 5b. PUBLIC SUPPLIER WHOLESALE CATALOG (by supplier id) ─────────────────
// @route   GET /api/suppliers/:id/products
// @access  Public
exports.getSupplierProducts = async (req, res) => {
  try {
    const { id } = req.params;

    if (!orm.isValidObjectId(id)) {
      return res.status(404).json({ message: "Supplier not found" });
    }

    const supplier = await Supplier.findOne({
      _id: id,
      status: "ACTIVE",
      verificationStatus: "VERIFIED",
    });

    if (!supplier) {
      return res.status(404).json({ message: "Supplier not found" });
    }

    const products = await WholesaleProduct.find({
      supplier: supplier._id,
      status: "ACTIVE",
    }).sort({ createdAt: -1 });

    // Where each product ships from (no store = the primary store).
    const { stores } = await supplierStores.listStores(supplier);
    const primary = stores.find((st) => st.isPrimary);
    const shipsFrom = (p) => {
      const st = stores.find((x) => String(x._id) === String(p.store)) || primary;
      return st ? { storeName: st.storeName, city: st.address?.city || "" } : null;
    };
    return res.status(200).json({ supplier, products: products.map((p) => ({ ...p.toObject(), shipsFrom: shipsFrom(p) })) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── 6. ADMIN: LIST ALL SUPPLIERS (any status) ──────────────────────────────
// @route   GET /api/admin/suppliers?status=&verificationStatus=&page=&pageSize=
// @access  Private (super_admin)
exports.adminGetSuppliers = async (req, res) => {
  try {
    const { status, verificationStatus, page = 1, pageSize = 20 } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (verificationStatus) filter.verificationStatus = verificationStatus;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limit = Math.min(parseInt(pageSize, 10) || 20, 100);
    const skip = (pageNum - 1) * limit;

    const [suppliers, total] = await Promise.all([
      Supplier.find(filter).populate("user", "Fullname email phone").skip(skip).limit(limit),
      Supplier.countDocuments(filter),
    ]);

    return res.status(200).json({
      data: suppliers,
      meta: { page: pageNum, pageSize: limit, total },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── 7. ADMIN: VERIFY / REJECT SUPPLIER ─────────────────────────────────────
// @route   PATCH /api/admin/suppliers/:id/verify
// @access  Private (super_admin)
exports.adminVerifySupplier = async (req, res) => {
  try {
    const { decision } = req.body; // "VERIFIED" | "REJECTED"
    const reason = String(req.body.reason || "").trim().slice(0, 500);

    if (!["VERIFIED", "REJECTED"].includes(decision)) {
      return res.status(400).json({ message: "Choose to verify or reject the supplier." });
    }
    if (decision === "REJECTED" && reason.length < 5) {
      return res.status(400).json({ message: "Tell the supplier what to fix: write a short reason for the rejection." });
    }
    if (!orm.isValidObjectId(req.params.id)) return res.status(400).json({ message: "A valid supplier ID is required." });

    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) {
      return res.status(404).json({ message: "Supplier not found" });
    }

    supplier.verificationStatus = decision;
    supplier.verificationNote = decision === "REJECTED" ? reason : "";
    await supplier.save();
    await require("../models/User").findByIdAndUpdate(supplier.user, { verificationStatus: decision });
    await require("../services/notification.service").verificationDecision(supplier.user, { kind: "supplier", name: supplier.businessName, decision, reason });

    return res.status(200).json({ message: `Supplier ${decision.toLowerCase()}`, supplier });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── 8. ADMIN: SUSPEND / ACTIVATE / BLOCK SUPPLIER ──────────────────────────
// @route   PATCH /api/admin/suppliers/:id/status
// @access  Private (super_admin)
exports.adminUpdateSupplierStatus = async (req, res) => {
  try {
    const { status } = req.body;

    if (!["ACTIVE", "SUSPENDED", "BLOCKED", "UNDER_REVIEW"].includes(status)) {
      return res.status(400).json({ message: "Invalid status value" });
    }

    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) {
      return res.status(404).json({ message: "Supplier not found" });
    }

    supplier.status = status;
    await supplier.save();

    return res.status(200).json({ message: `Supplier status set to ${status}`, supplier });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── 9. SUPPLIER: LIST OWN WHOLESALE PRODUCTS ────────────────────────────────
// @route   GET /api/suppliers/me/products
// @access  Private (role: "supplier", own catalog)
exports.getMyWholesaleProducts = async (req, res) => {
  try {
    const supplier = await resolveMySupplier(req.user.id);
    const products = await WholesaleProduct.find({ supplier: supplier._id }).sort({ createdAt: -1 })
      .populate("store", "storeName isPrimary")
      .populate("retailProduct", "price stockQuantity status slug sku");
    return res.status(200).json({ success: true, supplier: supplier._id, count: products.length, products });
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message });
  }
};

// ─── 10. SUPPLIER: CREATE WHOLESALE PRODUCT ──────────────────────────────────
// @route   POST /api/suppliers/me/products
// @access  Private (role: "supplier", own catalog)
exports.createWholesaleProduct = async (req, res) => {
  try {
    const supplier = await resolveMySupplier(req.user.id);
    const { name, wholesalePrice } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: "name is required" });
    }
    if (wholesalePrice === undefined || wholesalePrice === null || wholesalePrice === "" || Number(wholesalePrice) < 0) {
      return res.status(400).json({ message: "A valid wholesalePrice is required" });
    }

    const payload = sanitizeWholesalePayload(req.body);
    const product = await WholesaleProduct.create({ supplier: supplier._id, ...payload, ...(await storeFromBody(supplier, req.body)) });

    return res.status(201).json({ success: true, message: "Wholesale product created.", product });
  } catch (error) {
    return res.status(error.status || 400).json({ message: error.message });
  }
};

// ─── 11. SUPPLIER: UPDATE OWN WHOLESALE PRODUCT ──────────────────────────────
// @route   PUT /api/suppliers/me/products/:productId
// @access  Private (role: "supplier", own catalog)
exports.updateWholesaleProduct = async (req, res) => {
  try {
    const supplier = await resolveMySupplier(req.user.id);
    const product = await WholesaleProduct.findOne({ _id: req.params.productId, supplier: supplier._id });
    if (!product) {
      return res.status(404).json({ message: "Wholesale product not found" });
    }

    const payload = sanitizeWholesalePayload(req.body, {
      name: product.name,
      shortDescription: product.shortDescription,
      category: product.category,
      unit: product.unit,
      wholesalePrice: product.wholesalePrice,
      retailPrice: product.retailPrice,
      moq: product.moq,
      stockQuantity: product.stockQuantity,
      lowStockThreshold: product.lowStockThreshold,
      bulkDiscount: product.bulkDiscount,
      media: product.media,
    });
    const before = Number(product.stockQuantity) || 0;

    if (req.body.status !== undefined) {
      product.status = req.body.status;
    }

    Object.assign(product, payload, await storeFromBody(supplier, req.body));
    await product.save();
    // A stock change typed into the product form is a stock count, like on the Inventory page.
    if (payload.stockQuantity !== before) {
      await stock.recordWholesaleMovement({ supplier, product, type: "COUNT", before, after: payload.stockQuantity, reason: "Stock count correction", note: "Edited in the product form", performedBy: req.user._id });
    }

    return res.status(200).json({ success: true, message: "Wholesale product updated.", product });
  } catch (error) {
    return res.status(error.status || 400).json({ message: error.message });
  }
};

// ─── 12. SUPPLIER: DELETE OWN WHOLESALE PRODUCT ──────────────────────────────
// @route   DELETE /api/suppliers/me/products/:productId
// @access  Private (role: "supplier", own catalog)
exports.deleteWholesaleProduct = async (req, res) => {
  try {
    const supplier = await resolveMySupplier(req.user.id);
    const product = await WholesaleProduct.findOneAndDelete({ _id: req.params.productId, supplier: supplier._id });
    if (!product) {
      return res.status(404).json({ message: "Wholesale product not found" });
    }
    await supplierRetail.hideListing(product);
    return res.status(200).json({ success: true, message: "Wholesale product deleted." });
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message });
  }
};

// ─── 13. SUPPLIER: ADJUST STOCK OF A WHOLESALE PRODUCT ───────────────────────
// @route   PATCH /api/suppliers/me/products/:productId/stock   { mode: add|remove|set, quantity, reason, note }
// @access  Private (supplier owner, or team roles with "inventory")
exports.adjustWholesaleStock = async (req, res) => {
  try {
    const supplier = await resolveMySupplier(req.user.id);
    const { mode, quantity, reason, note } = req.body || {};
    const result = await stock.adjustWholesaleStock({ supplier, productId: req.params.productId, mode, quantity, reason, note, performedBy: req.user._id });
    return res.status(200).json({ success: true, message: "Stock updated.", ...result });
  } catch (error) {
    return res.status(error.statusCode || error.status || 500).json({ message: error.message });
  }
};

// ─── 14. SUPPLIER: STOCK HISTORY ─────────────────────────────────────────────
// @route   GET /api/suppliers/me/stock-movements?product=&limit=
// @access  Private (supplier and team)
exports.listWholesaleStockMovements = async (req, res) => {
  try {
    const supplier = await resolveMySupplier(req.user.id);
    const query = { vendor: supplier.user };
    if (orm.isValidObjectId(req.query.product)) query.product = req.query.product;
    const movements = await StockMovement.find(query)
      .sort({ createdAt: -1 })
      .limit(Math.min(Number(req.query.limit) || 50, 200))
      .populate("performedBy", "Fullname");
    return res.status(200).json({ movements, reasons: stock.WHOLESALE_REASONS });
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message });
  }
};

// ─── 15. SUPPLIER: STORES (same rules as vendor stores) ──────────────────────
// @route   GET /api/suppliers/me/stores            -> { store: primary, stores, maxStores }
// @route   POST /api/suppliers/me/stores           { storeName, contactEmail, contactPhone, city, ... }
// @route   PUT /api/suppliers/me/stores/:storeId
// @route   PATCH /api/suppliers/me/stores/:storeId/primary
// @route   DELETE /api/suppliers/me/stores/:storeId (its products move to the primary store)
// @route   POST /api/suppliers/me/products/move-store   { productIds, storeId, note }
// @access  Private (supplier; changes need "profile", moving products "inventory")
const storeAction = (work, status = 200) => async (req, res) => {
  try {
    const supplier = await resolveMySupplier(req.user.id);
    return res.status(status).json(await work(supplier, req));
  } catch (error) {
    return res.status(error.statusCode || error.status || 500).json({ message: error.message });
  }
};

exports.listMyStores = storeAction((supplier) => supplierStores.listStores(supplier));
exports.createMyStore = storeAction(async (supplier, req) => {
  const store = await supplierStores.createStore(supplier, req.body);
  return { message: `${store.storeName} has been registered.`, store };
}, 201);
exports.updateMyStore = storeAction(async (supplier, req) => ({ message: "Store details saved.", store: await supplierStores.updateStore(supplier, req.params.storeId, req.body) }));
exports.setMyPrimaryStore = storeAction(async (supplier, req) => {
  const store = await supplierStores.setPrimary(supplier, req.params.storeId);
  return { message: `${store.storeName} is now your primary store.`, store };
});
exports.deleteMyStore = storeAction(async (supplier, req) => {
  const { store, primary } = await supplierStores.removeStore(supplier, req.params.storeId);
  return { message: `${store.storeName} was deleted. Its products moved to ${primary.storeName}.` };
});
exports.moveProductsToStore = storeAction((supplier, req) => supplierStores.moveProducts(supplier, { ...(req.body || {}), performedBy: req.user._id }));

// ─── 16. SUPPLIER: SELL TO BUYERS ON THE MARKETPLACE ─────────────────────────
// @route   POST /api/suppliers/me/products/:productId/publish        { price, units }
// @route   POST /api/suppliers/me/products/:productId/listing-stock  { mode: add|remove, units }
// @route   POST /api/suppliers/me/products/:productId/unpublish
// @access  Private (supplier owner, or team roles with "catalog")
exports.publishToMarketplace = storeAction(async (supplier, req) => {
  const result = await supplierRetail.publish(supplier, req.params.productId, { ...(req.body || {}), performedBy: req.user._id });
  return { message: `${result.listing.name} is on the marketplace: ${result.listing.stockQuantity} units at ${Math.round(result.listing.price).toLocaleString("en-RW")} RWF.`, ...result };
});
exports.moveListingStock = storeAction(async (supplier, req) => {
  const result = await supplierRetail.moveListingStock(supplier, req.params.productId, { ...(req.body || {}), performedBy: req.user._id });
  return { message: `${result.listing.stockQuantity} units are now on the marketplace.`, ...result };
});
exports.unpublishFromMarketplace = storeAction(async (supplier, req) => {
  const result = await supplierRetail.unpublish(supplier, req.params.productId, { performedBy: req.user._id });
  return { message: `Removed from the marketplace${result.returned ? `; ${result.returned} units went back to wholesale stock` : ""}.`, ...result };
});
