// "Tell me when it's back" and "tell me when the price drops", for buyers.
// Saving a product to the wishlist also watches its price. A check every
// minute (slaWorker) tells buyers in the app, by push when it's set up.
const ProductAlert = require("../models/ProductAlert");
const Product = require("../models/Product");
const { effectivePrice, PRICE_FIELDS } = require("../utils/pricing.util");
const notifications = require("./notification.service");

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const idOf = (v) => String(v?._id || v?.id || v || "");
const money = (n) => `${new Intl.NumberFormat("en-RW").format(Math.round(Number(n) || 0))} RWF`;
const KINDS = ["BACK_IN_STOCK", "PRICE_DROP"];
const LIVE = ["ACTIVE", "OUT_OF_STOCK"];

async function subscribe(user, productId, kind) {
  const k = String(kind || "").toUpperCase();
  if (!KINDS.includes(k)) throw httpError(400, "Choose back in stock or price drop.");
  const product = await Product.findById(productId).select(`name status stockQuantity ${PRICE_FIELDS}`).lean();
  if (!product || !LIVE.includes(product.status)) throw httpError(404, "Product not found.");
  if (k === "BACK_IN_STOCK" && product.status === "ACTIVE" && product.stockQuantity > 0) throw httpError(409, "It's in stock now: you can order it.");
  const fields = { active: true, notifiedAt: null, priceAtSignup: effectivePrice(product) };
  const existing = await ProductAlert.findOne({ user: idOf(user), product: idOf(product), kind: k });
  if (existing) {
    Object.assign(existing, fields);
    await existing.save();
  } else {
    await ProductAlert.create({ user: idOf(user), product: idOf(product), kind: k, ...fields });
  }
  return {
    message: k === "BACK_IN_STOCK" ? `We'll tell you when ${product.name} is back.` : `We'll tell you when ${product.name} costs less than ${money(fields.priceAtSignup)}.`,
    alert: { kind: k, productId: idOf(product), active: true },
  };
}

async function unsubscribe(user, productId, kind) {
  const filter = { user: idOf(user), product: String(productId) };
  if (kind) filter.kind = String(kind).toUpperCase();
  await ProductAlert.deleteMany(filter);
  return { message: "Alert removed." };
}

async function mine(user) {
  const alerts = await ProductAlert.find({ user: idOf(user), active: true }).sort({ createdAt: -1 }).limit(200).lean();
  const products = await Product.find({ _id: { $in: alerts.map((a) => a.product) } }).select(`name slug media status stockQuantity ${PRICE_FIELDS}`).lean();
  const byId = new Map(products.map((p) => [idOf(p), p]));
  return {
    alerts: alerts.filter((a) => byId.has(idOf(a.product))).map((a) => {
      const p = byId.get(idOf(a.product));
      return { id: idOf(a), kind: a.kind, priceAtSignup: Number(a.priceAtSignup) || null, product: { id: idOf(p), name: p.name, slug: p.slug, image: p.media?.mainImage || "", price: effectivePrice(p), inStock: p.status === "ACTIVE" && p.stockQuantity > 0 } };
    }),
  };
}

/** Which alerts this buyer has on a product: { BACK_IN_STOCK: bool, PRICE_DROP: bool }. */
async function onProduct(user, productId) {
  const rows = await ProductAlert.find({ user: idOf(user), product: String(productId), active: true }).select("kind").lean();
  return Object.fromEntries(KINDS.map((k) => [k, rows.some((r) => r.kind === k)]));
}

/** Tells buyers about products that came back or got cheaper (every minute). */
async function check(now = new Date()) {
  const alerts = await ProductAlert.find({ active: true }).limit(2000);
  if (!alerts.length) return { backInStock: 0, priceDrops: 0 };
  const products = await Product.find({ _id: { $in: [...new Set(alerts.map((a) => idOf(a.product)))] } }).select(`name slug status stockQuantity ${PRICE_FIELDS}`).lean();
  const byId = new Map(products.map((p) => [idOf(p), p]));
  const counts = { backInStock: 0, priceDrops: 0 };
  for (const alert of alerts) {
    const p = byId.get(idOf(alert.product));
    if (!p || !LIVE.includes(p.status)) continue;
    const link = `/product/${p.slug || idOf(p)}`;
    if (alert.kind === "BACK_IN_STOCK" && p.status === "ACTIVE" && p.stockQuantity > 0) {
      alert.active = false;
      alert.notifiedAt = now;
      await alert.save();
      notifications.notify(alert.user, { type: "STOCK", title: `${p.name} is back in stock`, message: `Order it before it runs out again: ${money(effectivePrice(p, now))}.`, link }).catch(() => {});
      counts.backInStock += 1;
    } else if (alert.kind === "PRICE_DROP") {
      const price = effectivePrice(p, now);
      const was = Number(alert.priceAtSignup) || 0;
      // At least 1% less, so a rounding change doesn't send a message.
      if (was > 0 && price <= was * 0.99) {
        alert.priceAtSignup = price; // the next message needs a further drop
        alert.notifiedAt = now;
        await alert.save();
        notifications.notify(alert.user, { type: "STOCK", title: `Price drop: ${p.name}`, message: `Now ${money(price)} (was ${money(was)}).`, link }).catch(() => {});
        counts.priceDrops += 1;
      }
    }
  }
  return counts;
}

module.exports = { subscribe, unsubscribe, mine, onProduct, check, KINDS };
