// Stock that moves because of wholesale trade, and the supplier's own stock
// operations. Every change is recorded as a StockMovement, the same history
// vendors see on their Inventory page.
//
//  - stockVendorStore: when a wholesale order completes, the goods are added
//    to the vendor store chosen at ordering (the primary store by default).
//    A product bought before from the same supplier product is restocked;
//    otherwise a new store product is created from the supplier's listing.
//  - adjustWholesaleStock: a supplier adds, removes or counts stock.
const orm = require("../database/orm");
const Product = require("../models/Product");
const Store = require("../models/Store");
const Category = require("../models/Category");
const Supplier = require("../models/Supplier");
const WholesaleProduct = require("../models/WholesaleProduct");
const WholesaleOrder = require("../models/WholesaleOrder");
const StockMovement = require("../models/StockMovement");
const { getPrimaryStore } = require("../utils/vendorStore.util");

const httpError = (status, message) => Object.assign(new Error(message), { statusCode: status });
const notifications = () => require("./notification.service");

const MODE_TO_TYPE = { add: "RESTOCK", remove: "REMOVE", set: "COUNT" };
const WHOLESALE_REASONS = {
  RESTOCK: ["Restock", "Produced or harvested", "Vendor return", "Other"],
  REMOVE: ["Damaged", "Lost or stolen", "Expired", "Sold outside MVEC", "Other"],
  COUNT: ["Stock count correction", "Other"],
};

// The store a product is listed under (null store = vendor's primary store).
const effectiveStoreId = async (product) => {
  if (product.store) return product.store;
  const primary = await getPrimaryStore(product.vendor);
  return primary?._id || null;
};

// Keeps OUT_OF_STOCK in step with quantity (atomic updates skip save hooks).
const syncStockStatus = async (product, session) => {
  if (product.stockQuantity <= 0 && product.status !== "OUT_OF_STOCK") {
    return Product.findByIdAndUpdate(product._id, { $set: { status: "OUT_OF_STOCK", stockQuantity: 0 } }, { new: true, session });
  }
  if (product.stockQuantity > 0 && product.status === "OUT_OF_STOCK") {
    return Product.findByIdAndUpdate(product._id, { $set: { status: "ACTIVE" } }, { new: true, session });
  }
  return product;
};

// Same rule for supplier products; archived ones stay archived.
const syncWholesaleStatus = async (productOrId) => {
  const product = productOrId && productOrId.stockQuantity !== undefined ? productOrId : await WholesaleProduct.findById(productOrId);
  if (!product) return product;
  if (product.stockQuantity <= 0 && product.status === "ACTIVE") {
    return WholesaleProduct.findByIdAndUpdate(product._id, { $set: { status: "OUT_OF_STOCK" } }, { new: true });
  }
  if (product.stockQuantity > 0 && product.status === "OUT_OF_STOCK") {
    return WholesaleProduct.findByIdAndUpdate(product._id, { $set: { status: "ACTIVE" } }, { new: true });
  }
  return product;
};

// A store category for a supplier's category name (names compare without case
// in MySQL); falls back to General/Other, then to any category.
async function categoryFor(names) {
  for (const name of [...names.filter(Boolean), "General", "Other"]) {
    const found = await Category.findOne({ name: String(name).trim() }).select("_id");
    if (found) return found._id;
  }
  const any = await Category.findOne({}).sort({ createdAt: 1 }).select("_id");
  return any?._id || null;
}

// The store receiving the order: the one chosen at ordering if the vendor
// still owns it, else the primary store.
async function receivingStore(order) {
  const primary = await getPrimaryStore(order.vendor);
  if (order.store) {
    const chosen = await Store.findOne({ _id: order.store, vendor: order.vendor });
    if (chosen) return { store: chosen, primary };
  }
  return { store: primary, primary };
}

/**
 * Add one completed order's goods to the vendor's store. Safe to repeat: the
 * claim and every item are one transaction, so a failure part-way adds
 * nothing and a retry starts clean.
 */
async function stockVendorStore(order) {
  const session = await orm.startSession();
  session.startTransaction();
  let result;
  try {
    // Claim the order first so a repeated or concurrent completion adds nothing twice.
    const claimed = await WholesaleOrder.findOneAndUpdate({ _id: order._id, stockedAt: null }, { $set: { stockedAt: new Date() } }, { new: true, session });
    if (!claimed) {
      await session.abortTransaction();
      return { stocked: [], skipped: true };
    }
    const { store, primary } = await receivingStore(order);
    const storeId = store?._id ? String(store._id) : null;
    const primaryId = primary?._id ? String(primary._id) : null;
    const inThisStore = (p) => String(p.store || primaryId) === String(storeId);
    const supplier = await Supplier.findOne({ user: order.supplier }).select("_id businessName");
    const supplierName = supplier?.businessName || "your supplier";
    const note = `Wholesale order ${order.orderNumber}`;
    const stocked = [];

    for (const item of order.items || []) {
      const quantity = Number(item.quantity) || 0;
      if (quantity <= 0) continue;
      const unitPrice = Math.round(Number(item.unitPrice) || 0);
      const source = item.product && orm.isValidObjectId(item.product) ? await WholesaleProduct.findById(item.product) : null;

      // The same goods bought before, in the same store: from the catalog by
      // supplier product, from a quote by supplier and name.
      const candidates = source
        ? await Product.find({ vendor: order.vendor, wholesaleProduct: source._id }).session(session)
        : supplier ? await Product.find({ vendor: order.vendor, supplier: supplier._id, name: item.productName }).session(session) : [];
      const existing = candidates.find(inThisStore);

      let product;
      let before = 0;
      if (existing) {
        product = await Product.findByIdAndUpdate(existing._id, { $inc: { stockQuantity: quantity }, $set: { costPrice: unitPrice } }, { new: true, session });
        before = (Number(product.stockQuantity) || 0) - quantity;
        product = await syncStockStatus(product, session);
      } else {
        const category = await categoryFor([source?.category, order.category]);
        if (!category) throw new Error("No product category exists to list the goods under.");
        // The supplier's suggested retail price makes it sellable right away;
        // without one it waits as a draft for the vendor to price it.
        const retail = Math.round(Number(source?.retailPrice) || 0);
        const priced = retail > unitPrice;
        [product] = await Product.create([{
          vendor: order.vendor,
          store: storeId && storeId !== primaryId ? storeId : null,
          supplier: supplier?._id || null,
          wholesaleProduct: source?._id || null,
          category,
          name: item.productName,
          description: source?.shortDescription || `${item.productName}, bought wholesale from ${supplierName}.`,
          shortDescription: (source?.shortDescription || "").slice(0, 300),
          price: priced ? retail : Math.max(unitPrice, 1),
          costPrice: unitPrice,
          stockQuantity: quantity,
          status: priced ? "ACTIVE" : "DRAFT",
          media: { mainImage: source?.media?.mainImage || "", gallery: source?.media?.gallery || [] },
        }], { session });
      }

      await StockMovement.create([{
        vendor: order.vendor,
        product: product._id,
        productName: product.name,
        store: storeId,
        type: "RESTOCK",
        quantity,
        before,
        after: before + quantity,
        reason: "Received from supplier",
        note,
        performedBy: order.vendor,
      }], { session });
      stocked.push({ product: product._id, name: product.name, quantity, created: !existing, draft: product.status === "DRAFT" });
    }

    await session.commitTransaction();
    result = { stocked, store: storeId, storeName: store?.storeName };
  } catch (error) {
    // Nothing was added and the claim is undone, so a retry (or an admin) can stock it.
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }

  const drafts = result.stocked.filter((s) => s.draft).length;
  const units = result.stocked.reduce((n, s) => n + s.quantity, 0);
  notifications().notify(order.vendor, {
    type: "ORDER",
    title: `${order.orderNumber} added to ${result.storeName || "your store"}`,
    message: `${units} unit${units === 1 ? "" : "s"} added to your inventory.${drafts ? ` ${drafts} new product${drafts === 1 ? " is a draft" : "s are drafts"}: set a selling price to list ${drafts === 1 ? "it" : "them"}.` : ""}`,
    link: drafts ? "/vendor/products" : "/vendor/inventory",
  }).catch(() => {});
  return { stocked: result.stocked, store: result.store };
}

/** A supplier adds, removes or counts stock of one wholesale product. */
async function adjustWholesaleStock({ supplier, productId, mode, quantity: raw, reason = "", note = "", performedBy }) {
  const type = MODE_TO_TYPE[mode];
  const quantity = Number(raw);
  if (!type) throw httpError(400, "Choose add, remove or set.");
  if (!Number.isInteger(quantity) || quantity < 0 || (mode !== "set" && quantity === 0)) {
    throw httpError(400, mode === "set" ? "Enter a whole number of 0 or more." : "Enter a whole number greater than 0.");
  }
  if (!orm.isValidObjectId(productId)) throw httpError(404, "Wholesale product not found.");
  const owned = { _id: productId, supplier: supplier._id };
  const current = await WholesaleProduct.findOne(owned);
  if (!current) throw httpError(404, "Wholesale product not found.");

  // Atomic, so vendors ordering at the same moment are never overwritten.
  let updated;
  if (mode === "add") {
    updated = await WholesaleProduct.findOneAndUpdate(owned, { $inc: { stockQuantity: quantity } }, { new: true });
  } else if (mode === "remove") {
    updated = await WholesaleProduct.findOneAndUpdate({ ...owned, stockQuantity: { $gte: quantity } }, { $inc: { stockQuantity: -quantity } }, { new: true });
    if (!updated) {
      const latest = await WholesaleProduct.findOne(owned).select("stockQuantity");
      throw httpError(409, `Only ${latest?.stockQuantity ?? 0} units are in stock.`);
    }
  } else {
    updated = await WholesaleProduct.findOneAndUpdate(owned, { $set: { stockQuantity: quantity } }, { new: true });
  }
  updated = await syncWholesaleStatus(updated);

  const after = updated.stockQuantity;
  const before = mode === "add" ? after - quantity : mode === "remove" ? after + quantity : current.stockQuantity;
  const movement = await recordWholesaleMovement({ supplier, product: updated, type, before, after, reason: String(reason).slice(0, 60) || WHOLESALE_REASONS[type][0], note, performedBy });
  return { product: updated, movement };
}

function recordWholesaleMovement({ supplier, product, type, before, after, reason, note = "", performedBy }) {
  // Supplier movements are kept under the supplier owner's account.
  return StockMovement.create({
    vendor: supplier.user,
    product: product._id,
    productName: product.name,
    store: null,
    type,
    quantity: after - before,
    before,
    after,
    reason,
    note: String(note).slice(0, 300),
    performedBy,
  });
}

module.exports = {
  WHOLESALE_REASONS,
  categoryFor,
  effectiveStoreId,
  syncStockStatus,
  syncWholesaleStatus,
  stockVendorStore,
  adjustWholesaleStock,
  recordWholesaleMovement,
};
