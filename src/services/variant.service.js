// Product variants: a product's sizes/colours, each with its own stock and,
// optionally, its own price. The product's stockQuantity is always the sum of
// its variants' stock, so every buyer-facing "in stock" check keeps working.
//
// A cart or checkout line names a variant with the key "productId~variantId";
// clients pass that key wherever they used to pass a product id.
const ProductVariant = require("../models/ProductVariant");
const Product = require("../models/Product");
const { effectivePrice } = require("../utils/pricing.util");

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const idOf = (v) => String(v?._id || v?.id || v || "");
const MAX_VARIANTS = 100;

/** "productId~variantId" (or a bare product id) -> { productId, variantId }. */
function parseKey(raw) {
  const [productId, variantId] = String(raw || "").split("~");
  return { productId, variantId: variantId || null };
}
const keyOf = (productId, variantId) => (variantId ? `${idOf(productId)}~${idOf(variantId)}` : idOf(productId));

/** productId -> [variant] (in the seller's order). */
async function byProduct(productIds) {
  const ids = [...new Set(productIds.map(idOf))].filter(Boolean);
  const map = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return map;
  const rows = await ProductVariant.find({ product: { $in: ids } }).sort({ position: 1 }).lean();
  for (const v of rows) map.get(idOf(v.product))?.push(v);
  return map;
}

/** The price of one unit: a variant's own price, else the product's (deal or discount included). */
function priceOf(product, variant) {
  if (variant && variant.price !== null && variant.price !== undefined && Number(variant.price) > 0) return Number(variant.price);
  return effectivePrice(product);
}

/** What buyers see: [{ id, key, label, options, price, stockQuantity, image, sku }] and the option names with values. */
function publicView(product, variants = []) {
  const list = variants.map((v) => ({
    id: idOf(v), key: keyOf(product._id || product.id, v), label: v.label, options: v.options || {},
    price: priceOf(product, v), ownPrice: v.price === null || v.price === undefined ? null : Number(v.price),
    stockQuantity: Number(v.stockQuantity) || 0, image: v.image || "", sku: v.sku || "",
  }));
  const names = [];
  for (const v of list) for (const name of Object.keys(v.options)) if (!names.includes(name)) names.push(name);
  const options = names.map((name) => ({ name, values: [...new Set(list.map((v) => v.options[name]).filter(Boolean))] }));
  return { variants: list, variantOptions: options };
}

/** Adds `variants` and `variantOptions` to product API objects. */
async function attach(products) {
  const list = Array.isArray(products) ? products : [products];
  const map = await byProduct(list.map((p) => p?._id || p?.id));
  for (const p of list) if (p) Object.assign(p, publicView(p, map.get(idOf(p)) || []));
  return products;
}

const cleanOptions = (raw) => {
  const out = {};
  for (const [k, v] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
    const name = String(k).trim().slice(0, 40);
    const value = String(v ?? "").trim().slice(0, 60);
    if (name && value) out[name[0].toUpperCase() + name.slice(1)] = value;
  }
  return out;
};

/**
 * Replaces a product's variants with `rows` ([{ id?, options, price?, stockQuantity, sku?, image? }]).
 * Rows with an id update that variant; others are new; missing ones are removed.
 * An empty list turns variants off (the product keeps its own stock).
 */
async function setVariants(productId, rows = []) {
  if (!Array.isArray(rows)) throw httpError(400, "Send the variants as a list.");
  if (rows.length > MAX_VARIANTS) throw httpError(400, `A product can have at most ${MAX_VARIANTS} variants.`);
  const product = await Product.findById(productId);
  if (!product) throw httpError(404, "Product not found.");
  const existing = await ProductVariant.find({ product: idOf(product) });
  const byId = new Map(existing.map((v) => [idOf(v), v]));
  const seen = new Set();
  const labels = new Set();
  const kept = [];
  for (const [position, row] of rows.entries()) {
    const options = cleanOptions(row.options);
    const label = Object.values(options).join(" / ") || String(row.label || "").trim().slice(0, 120);
    if (!label) throw httpError(400, `Variant ${position + 1}: choose its size, colour or other option.`);
    if (labels.has(label.toLowerCase())) throw httpError(400, `"${label}" is listed twice. Each variant must be different.`);
    labels.add(label.toLowerCase());
    const stock = Number(row.stockQuantity ?? row.stock ?? 0);
    if (!Number.isInteger(stock) || stock < 0) throw httpError(400, `${label}: stock must be a whole number of 0 or more.`);
    const rawPrice = row.price === "" || row.price === undefined ? null : row.price;
    const price = rawPrice === null ? null : Number(rawPrice);
    if (price !== null && (!Number.isFinite(price) || price < 1)) throw httpError(400, `${label}: the price must be at least 1 RWF, or empty to use the product's price.`);
    const fields = { label, options, price, stockQuantity: stock, sku: String(row.sku || "").trim().slice(0, 80) || null, image: String(row.image || "").slice(0, 1000) || null, position };
    const current = row.id && byId.get(String(row.id));
    if (current) {
      Object.assign(current, fields);
      await current.save();
      seen.add(idOf(current));
      kept.push(current);
    } else {
      kept.push(await ProductVariant.create({ product: idOf(product), ...fields }));
    }
  }
  for (const v of existing) if (!seen.has(idOf(v))) await ProductVariant.deleteOne({ _id: v._id });
  if (kept.length) {
    product.stockQuantity = kept.reduce((n, v) => n + (Number(v.stockQuantity) || 0), 0);
    await product.save();
  }
  return publicView(product, kept.map((v) => (v.toObject ? v.toObject() : v)));
}

/** Takes `quantity` units of a variant, only while that many are left. */
async function take(variantId, quantity) {
  const res = await ProductVariant.updateOne({ _id: variantId, stockQuantity: { $gte: quantity } }, { $inc: { stockQuantity: -quantity } });
  return res.modifiedCount > 0;
}

/** Puts `quantity` units back on a variant. */
async function giveBack(variantId, quantity) {
  await ProductVariant.updateOne({ _id: variantId }, { $inc: { stockQuantity: quantity } });
}

module.exports = { parseKey, keyOf, byProduct, priceOf, publicView, attach, setVariants, take, giveBack };
