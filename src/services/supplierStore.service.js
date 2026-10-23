// Supplier stores work like vendor stores (utils/vendorStore.util and
// store.controller): one primary store, up to MAX_STORES_PER_VENDOR in all,
// and wholesale products without a store belong to the primary one. A
// supplier who never registered a store gets a primary one made from their
// profile the first time it is needed.
const orm = require("../database/orm");
const SupplierStore = require("../models/SupplierStore");
const WholesaleProduct = require("../models/WholesaleProduct");
const StockMovement = require("../models/StockMovement");
const { MAX_STORES_PER_VENDOR } = require("../utils/vendorStore.util");

const httpError = (status, message) => Object.assign(new Error(message), { statusCode: status });
const EDITABLE = ["storeName", "logo", "description", "businessCategory", "contactEmail", "contactPhone", "businessAddress"];

const locationText = (location) => {
  if (!location) return "";
  if (typeof location === "string") return location;
  return location.district || location.city || location.province || "";
};

function fieldsFrom(body = {}) {
  const fields = Object.fromEntries(EDITABLE.filter((k) => body[k] !== undefined).map((k) => [k, typeof body[k] === "string" ? body[k].trim() : body[k]]));
  if (body.city !== undefined) fields.address = { city: String(body.city || "").trim() || "Kigali" };
  return fields;
}

async function primaryStore(supplier) {
  const primary = await SupplierStore.findOne({ supplier: supplier._id, isPrimary: true });
  if (primary) return primary;
  const oldest = await SupplierStore.findOne({ supplier: supplier._id }).sort({ createdAt: 1 });
  if (oldest) {
    await SupplierStore.updateOne({ _id: oldest._id }, { $set: { isPrimary: true } });
    oldest.isPrimary = true;
    return oldest;
  }
  return SupplierStore.create({
    supplier: supplier._id,
    isPrimary: true,
    storeName: supplier.businessName,
    logo: supplier.logoUrl || "",
    description: supplier.description || "",
    businessCategory: supplier.category || "General",
    contactEmail: supplier.email,
    contactPhone: supplier.phone,
    address: { city: locationText(supplier.location) || "Kigali" },
  });
}

/** All stores, primary first, with how many products each holds. */
async function listStores(supplier) {
  const primary = await primaryStore(supplier);
  const stores = await SupplierStore.find({ supplier: supplier._id }).sort({ isPrimary: -1, createdAt: 1 });
  const products = await WholesaleProduct.find({ supplier: supplier._id }).select("store").lean();
  const counts = {};
  for (const p of products) {
    const key = String(p.store || primary._id);
    counts[key] = (counts[key] || 0) + 1;
  }
  return {
    store: primary,
    stores: stores.map((s) => ({ ...s.toObject(), productCount: counts[String(s._id)] || 0 })),
    maxStores: MAX_STORES_PER_VENDOR,
  };
}

/** A store the supplier owns; empty = the primary store, null when not theirs. */
async function resolveOwnedStore(supplier, storeId) {
  if (storeId === undefined || storeId === null || storeId === "") return primaryStore(supplier);
  if (!orm.isValidObjectId(storeId)) return null;
  return SupplierStore.findOne({ _id: storeId, supplier: supplier._id });
}

async function findOwned(supplier, id) {
  const store = orm.isValidObjectId(id) ? await SupplierStore.findOne({ _id: id, supplier: supplier._id }) : null;
  if (!store) throw httpError(404, "Store not found.");
  return store;
}

async function createStore(supplier, body) {
  const fields = fieldsFrom(body);
  if (!fields.storeName || !fields.contactEmail || !fields.contactPhone) throw httpError(400, "Store name, email, and phone are required.");
  await primaryStore(supplier); // the profile store comes first
  const count = await SupplierStore.countDocuments({ supplier: supplier._id });
  if (count >= MAX_STORES_PER_VENDOR) throw httpError(400, `You can own up to ${MAX_STORES_PER_VENDOR} stores.`);
  return SupplierStore.create({ businessCategory: supplier.category || "General", ...fields, supplier: supplier._id, isPrimary: false });
}

async function updateStore(supplier, id, body) {
  const store = await findOwned(supplier, id);
  const fields = fieldsFrom(body);
  if (fields.storeName === "" || fields.contactEmail === "" || fields.contactPhone === "") throw httpError(400, "Store name, email, and phone are required.");
  Object.assign(store, fields);
  await store.save();
  return store;
}

async function setPrimary(supplier, id) {
  const store = await findOwned(supplier, id);
  if (store.isPrimary) return store;
  const previous = await primaryStore(supplier);
  // Unassigned products follow the primary store, so pin them to the old one.
  await WholesaleProduct.updateMany({ supplier: supplier._id, store: null }, { $set: { store: previous._id } });
  await SupplierStore.updateMany({ supplier: supplier._id, _id: { $ne: store._id } }, { $set: { isPrimary: false } });
  store.isPrimary = true;
  await store.save();
  return store;
}

/** Delete a non-primary store; its products move to the primary store. */
async function removeStore(supplier, id) {
  const store = await findOwned(supplier, id);
  if (store.isPrimary) throw httpError(400, "Make another store primary before deleting this one.");
  const primary = await primaryStore(supplier);
  await WholesaleProduct.updateMany({ store: store._id }, { $set: { store: primary._id } });
  await SupplierStore.deleteOne({ _id: store._id });
  return { store, primary };
}

/**
 * Move products to another store, recording a transfer. Stock movements link
 * to retail stores only, so the store names go in the note.
 */
async function moveProducts(supplier, { productIds, storeId, note = "", performedBy }) {
  if (!Array.isArray(productIds) || !productIds.length || !productIds.every((p) => orm.isValidObjectId(p))) throw httpError(400, "Select at least one product.");
  const target = storeId ? await resolveOwnedStore(supplier, storeId) : null;
  if (!target) throw httpError(400, "Select one of your own stores.");
  const products = await WholesaleProduct.find({ _id: { $in: productIds }, supplier: supplier._id });
  if (products.length !== productIds.length) throw httpError(404, "Some products were not found.");

  const primary = await primaryStore(supplier);
  const stores = await SupplierStore.find({ supplier: supplier._id }).select("storeName").lean();
  const nameOf = (sid) => stores.find((s) => String(s._id) === String(sid))?.storeName || "—";
  const moves = products.filter((p) => String(p.store || primary._id) !== String(target._id));
  if (moves.length) {
    await WholesaleProduct.updateMany({ _id: { $in: moves.map((p) => p._id) } }, { $set: { store: target._id } });
    const extra = String(note).trim();
    await StockMovement.insertMany(moves.map((p) => ({
      vendor: supplier.user,
      product: p._id,
      productName: p.name,
      store: null,
      type: "TRANSFER",
      quantity: 0,
      before: p.stockQuantity,
      after: p.stockQuantity,
      reason: "Moved to another store",
      note: `${nameOf(p.store || primary._id)} → ${target.storeName}${extra ? ` · ${extra}` : ""}`.slice(0, 300),
      performedBy,
    })));
  }
  const skipped = products.length - moves.length;
  return {
    moved: moves.length,
    message: `${moves.length} product${moves.length === 1 ? "" : "s"} moved to ${target.storeName}${skipped ? ` (${skipped} already there)` : ""}.`,
  };
}

module.exports = { primaryStore, listStores, resolveOwnedStore, createStore, updateStore, setPrimary, removeStore, moveProducts };
