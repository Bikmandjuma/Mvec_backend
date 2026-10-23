// Suppliers selling to buyers. Publishing a wholesale product creates a normal
// marketplace Product sold by the supplier, so buyers find it, buy it and
// have it delivered exactly like a vendor's product (same checkout, escrow,
// delivery code and payout into the supplier's balance).
//
// Stock: the supplier chooses how many units go on the marketplace. They are
// taken out of wholesale stock into the listing and can be moved back at any
// time, so a unit is never offered to vendors and buyers at once.
//
// The listing belongs to the supplier's shop: a retail store made once from
// their primary supplier store, which gives buyers a store page, delivery
// zones and a pickup address like any vendor store.
const orm = require("../database/orm");
const Product = require("../models/Product");
const Store = require("../models/Store");
const WholesaleProduct = require("../models/WholesaleProduct");
const StockMovement = require("../models/StockMovement");
const supplierStores = require("./supplierStore.service");
const stock = require("./stock.service");
const { uniqueSlug } = require("../utils/vendorStore.util");

const httpError = (status, message) => Object.assign(new Error(message), { statusCode: status });

/** The supplier's buyer-facing shop, created on first publish. */
async function ensureShop(supplier) {
  const existing = await Store.findOne({ vendor: supplier.user }).sort({ isPrimary: -1, createdAt: 1 });
  if (existing) return existing;
  const from = await supplierStores.primaryStore(supplier);
  const base = from.storeName || supplier.businessName;
  // Store names are unique across MVEC.
  let storeName = base;
  for (const candidate of [base, `${base} Shop`, `${base} Shop ${Date.now().toString(36).slice(-4)}`]) {
    storeName = candidate;
    if (!(await Store.exists({ storeName: candidate }))) break;
  }
  return Store.create({
    vendor: supplier.user,
    isPrimary: true,
    storeName,
    slug: await uniqueSlug(storeName),
    logo: from.logo || supplier.logoUrl || "",
    description: from.description || supplier.description || "",
    businessCategory: from.businessCategory || supplier.category || "General",
    contactEmail: from.contactEmail || supplier.email,
    contactPhone: from.contactPhone || supplier.phone,
    address: { city: from.address?.city || "Kigali", street: from.businessAddress || "", country: "Rwanda" },
    businessAddress: from.businessAddress || from.address?.city || "",
    location: from.address?.city || "Kigali",
    status: "ACTIVE",
  });
}

async function ownedProduct(supplier, productId) {
  const product = orm.isValidObjectId(productId) ? await WholesaleProduct.findOne({ _id: productId, supplier: supplier._id }) : null;
  if (!product) throw httpError(404, "Wholesale product not found.");
  return product;
}

const wholeUnits = (raw, { allowZero = true } = {}) => {
  const n = Number(raw ?? 0);
  if (!Number.isInteger(n) || n < 0 || (!allowZero && n === 0)) throw httpError(400, allowZero ? "Enter a whole number of units, 0 or more." : "Enter a whole number of units greater than 0.");
  return n;
};

// Units leave wholesale stock (atomically, so vendor orders can't take them meanwhile).
async function takeFromWholesale(product, units) {
  if (!units) return product;
  const taken = await WholesaleProduct.findOneAndUpdate({ _id: product._id, stockQuantity: { $gte: units } }, { $inc: { stockQuantity: -units } }, { new: true });
  if (!taken) {
    const latest = await WholesaleProduct.findById(product._id).select("stockQuantity");
    throw httpError(409, `Only ${latest?.stockQuantity ?? 0} units are in wholesale stock.`);
  }
  return stock.syncWholesaleStatus(taken);
}

async function record({ supplier, wholesale, listing, units, toMarketplace, performedBy, shop }) {
  const listingAfter = Number(listing.stockQuantity) || 0;
  const wholesaleAfter = Number(wholesale.stockQuantity) || 0;
  const signed = toMarketplace ? units : -units;
  await stock.recordWholesaleMovement({
    supplier, product: wholesale, type: toMarketplace ? "REMOVE" : "RESTOCK", before: wholesaleAfter + signed, after: wholesaleAfter,
    reason: toMarketplace ? "Put on the marketplace" : "Back from the marketplace", note: `Marketplace listing ${listing.sku || ""}`.trim(), performedBy,
  });
  await StockMovement.create({
    vendor: supplier.user, product: listing._id, productName: listing.name, store: shop?._id || listing.store || null,
    type: toMarketplace ? "RESTOCK" : "REMOVE", quantity: signed, before: listingAfter - signed, after: listingAfter,
    reason: toMarketplace ? "From wholesale stock" : "Back to wholesale stock", note: "", performedBy,
  });
}

/**
 * Publish (or update) the marketplace listing: set the buyer price and move
 * `units` from wholesale stock onto it. { price, units }
 */
async function publish(supplier, productId, { price, units: rawUnits, performedBy } = {}) {
  if (supplier.status !== "ACTIVE" || supplier.verificationStatus !== "VERIFIED") throw httpError(403, "MVEC must verify your supplier profile before you sell to buyers.");
  const wholesale = await ownedProduct(supplier, productId);
  if (wholesale.status === "ARCHIVED") throw httpError(400, "Restore this product before publishing it.");
  const buyerPrice = Math.round(Number(price));
  if (!Number.isFinite(buyerPrice) || buyerPrice < 1) throw httpError(400, "Enter the price buyers pay, in RWF.");
  const units = wholeUnits(rawUnits);
  let listing = wholesale.retailProduct ? await Product.findOne({ _id: wholesale.retailProduct, vendor: supplier.user }) : null;
  if (!listing && units === 0) throw httpError(400, "Put at least 1 unit on the marketplace.");

  const shop = await ensureShop(supplier);
  const after = await takeFromWholesale(wholesale, units);
  const unitCost = Math.round(Number(wholesale.wholesalePrice) * (1 - (Number(wholesale.bulkDiscount) || 0) / 100));
  try {
    if (listing) {
      const stockAfter = Number(listing.stockQuantity) + units;
      listing = await Product.findByIdAndUpdate(listing._id, {
        $inc: { stockQuantity: units },
        $set: { price: buyerPrice, costPrice: unitCost, status: stockAfter > 0 ? "ACTIVE" : "OUT_OF_STOCK", discountType: null, discountValue: null, discountPrice: null },
      }, { new: true });
    } else {
      const category = await stock.categoryFor([wholesale.category]);
      if (!category) throw httpError(400, "No product category exists yet; ask MVEC to add one.");
      listing = await Product.create({
        vendor: supplier.user,
        store: shop._id,
        supplier: supplier._id,
        wholesaleProduct: wholesale._id,
        category,
        name: wholesale.name,
        description: wholesale.shortDescription || wholesale.name,
        shortDescription: (wholesale.shortDescription || "").slice(0, 300),
        price: buyerPrice,
        costPrice: unitCost,
        stockQuantity: units,
        status: "ACTIVE",
        media: { mainImage: wholesale.media?.mainImage || "", gallery: wholesale.media?.gallery || [] },
      });
      await WholesaleProduct.updateOne({ _id: wholesale._id }, { $set: { retailProduct: listing._id } });
    }
  } catch (error) {
    // Put the units back if the listing could not be saved.
    if (units) {
      await WholesaleProduct.updateOne({ _id: wholesale._id }, { $inc: { stockQuantity: units } });
      await stock.syncWholesaleStatus(wholesale._id);
    }
    throw error;
  }
  if (units) await record({ supplier, wholesale: after, listing, units, toMarketplace: true, performedBy, shop });
  return { listing, product: await WholesaleProduct.findById(wholesale._id), shop };
}

/** Move units between the listing and wholesale stock. { mode: "add" | "remove", units } */
async function moveListingStock(supplier, productId, { mode, units: rawUnits, performedBy } = {}) {
  const wholesale = await ownedProduct(supplier, productId);
  const listing = wholesale.retailProduct ? await Product.findOne({ _id: wholesale.retailProduct, vendor: supplier.user }) : null;
  if (!listing) throw httpError(400, "Publish this product to the marketplace first.");
  const units = wholeUnits(rawUnits, { allowZero: false });
  if (mode === "add") return publish(supplier, productId, { price: listing.price, units, performedBy });
  if (mode !== "remove") throw httpError(400, "Choose add or remove.");
  const updated = await Product.findOneAndUpdate({ _id: listing._id, stockQuantity: { $gte: units } }, { $inc: { stockQuantity: -units } }, { new: true });
  if (!updated) throw httpError(409, `Only ${listing.stockQuantity} units are on the marketplace (sold units can't be moved back).`);
  const synced = await stock.syncStockStatus(updated);
  const back = await WholesaleProduct.findByIdAndUpdate(wholesale._id, { $inc: { stockQuantity: units } }, { new: true });
  const after = await stock.syncWholesaleStatus(back);
  await record({ supplier, wholesale: after, listing: synced, units, toMarketplace: false, performedBy });
  return { listing: synced, product: await WholesaleProduct.findById(wholesale._id) };
}

/** Take the listing off the marketplace; unsold units go back to wholesale stock. */
async function unpublish(supplier, productId, { performedBy } = {}) {
  const wholesale = await ownedProduct(supplier, productId);
  const listing = wholesale.retailProduct ? await Product.findOne({ _id: wholesale.retailProduct, vendor: supplier.user }) : null;
  if (!listing) throw httpError(400, "This product is not on the marketplace.");
  const units = Number(listing.stockQuantity) || 0;
  let result = { listing, product: wholesale };
  if (units > 0) result = await moveListingStock(supplier, productId, { mode: "remove", units, performedBy });
  const hidden = await Product.findByIdAndUpdate(listing._id, { $set: { status: "INACTIVE" } }, { new: true });
  return { listing: hidden, product: result.product, returned: units };
}

/** When a wholesale product is deleted its listing leaves the marketplace (orders keep their history). */
async function hideListing(wholesale) {
  if (wholesale.retailProduct) await Product.updateOne({ _id: wholesale.retailProduct }, { $set: { status: "INACTIVE" } });
}

module.exports = { ensureShop, publish, moveListingStock, unpublish, hideListing };
