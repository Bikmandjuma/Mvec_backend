// Seller coupons at checkout. A code belongs to one seller (optionally one of
// their stores, a product or a category); its discount applies only to that
// seller's lines and is paid by the seller: escrow is computed on the
// discounted line totals, and a free-shipping code zeroes that seller's
// delivery fee.
const Promotion = require("../models/Promotion");
const Order = require("../models/Order");

const round = (n) => Math.round(Number(n) || 0);
const fmt = (n) => `${round(n).toLocaleString("en-RW")} RWF`;
const endOfDay = (d) => { const x = new Date(d); x.setUTCHours(23, 59, 59, 999); return x; };

// Status as buyers experience it: dates and usage limits applied.
function effectiveStatus(p, now = new Date()) {
  if (!["ACTIVE", "SCHEDULED"].includes(p.status)) return p.status;
  if (p.endsAt && endOfDay(p.endsAt) < now) return "EXPIRED";
  if (p.usageLimit && Number(p.usedCount) >= Number(p.usageLimit)) return "USED_UP";
  if (p.startsAt && new Date(p.startsAt) > now) return "SCHEDULED";
  return p.status === "SCHEDULED" ? "ACTIVE" : p.status;
}

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

const lineMatches = (promo, product) => {
  if (!product || String(product.vendor) !== String(promo.vendor)) return false;
  if (promo.store && product.store && String(product.store) !== String(promo.store)) return false;
  if (promo.product && String(product._id) !== String(promo.product)) return false;
  if (promo.category && String(product.category) !== String(promo.category)) return false;
  return true;
};

/**
 * Work out a coupon for a basket.
 * lines: [{ product (doc), quantity, price }]; parcels: shippingBreakdown.
 * Returns { promotion, code, type, lineDiscounts: Map(index -> amount),
 *           itemDiscount, shippingDiscount, discount, message }.
 */
async function quote(code, { lines, parcels = [], userId = null }) {
  const clean = String(code || "").trim().toUpperCase();
  if (!clean) throw fail("Enter a coupon code.");
  const promo = await Promotion.findOne({ code: clean });
  if (!promo || !promo.vendor) throw fail("This coupon code doesn't exist.", 404);
  const status = effectiveStatus(promo);
  if (status !== "ACTIVE") {
    throw fail({
      SCHEDULED: `This code starts on ${new Date(promo.startsAt).toLocaleDateString("en-GB")}.`,
      EXPIRED: "This code has expired.",
      USED_UP: "This code has reached its usage limit.",
    }[status] || "This code isn't active.");
  }
  if (userId && String(userId) === String(promo.vendor)) throw fail("You can't use your own coupon.");

  const eligible = lines.map((l, i) => ({ ...l, i })).filter((l) => lineMatches(promo, l.product));
  if (!eligible.length) throw fail("This code doesn't apply to the items in your basket.");
  const eligibleSubtotal = eligible.reduce((t, l) => t + Number(l.price) * Number(l.quantity), 0);
  if (promo.minOrderAmount && eligibleSubtotal < promo.minOrderAmount) {
    throw fail(`Spend at least ${fmt(promo.minOrderAmount)} on this seller's items to use this code (you have ${fmt(eligibleSubtotal)}).`);
  }

  const lineDiscounts = new Map();
  let itemDiscount = 0;
  let shippingDiscount = 0;
  if (promo.type === "FREE_SHIPPING") {
    shippingDiscount = parcels
      .filter((p) => String(p.vendor) === String(promo.vendor) && (!promo.store || !p.store || String(p.store) === String(promo.store)))
      .reduce((t, p) => t + Number(p.fee || 0), 0);
    if (!shippingDiscount) throw fail("Delivery from this seller is already free.");
  } else {
    itemDiscount = promo.type === "PERCENT"
      ? round((eligibleSubtotal * Math.min(100, Math.max(0, promo.value))) / 100)
      : Math.min(round(promo.value), round(eligibleSubtotal));
    // Spread over the eligible lines in proportion; the last line takes the rounding.
    let left = itemDiscount;
    eligible.forEach((l, k) => {
      const share = k === eligible.length - 1 ? left : round((itemDiscount * Number(l.price) * Number(l.quantity)) / eligibleSubtotal);
      lineDiscounts.set(l.i, share);
      left -= share;
    });
  }
  const discount = itemDiscount + shippingDiscount;
  return {
    promotion: promo, code: promo.code, type: promo.type, name: promo.name,
    lineDiscounts, itemDiscount, shippingDiscount, discount,
    message: promo.type === "FREE_SHIPPING" ? `Free delivery applied (${fmt(shippingDiscount)} off).` : `${fmt(itemDiscount)} off applied.`,
  };
}

/**
 * Apply a quote to order data in place: line discounts on items, free
 * delivery on parcels. Returns the coupon fields for the order.
 */
function applyToOrder(q, items, shipping) {
  items.forEach((item, i) => { item.discount = q.lineDiscounts.get(i) || 0; });
  if (q.shippingDiscount) {
    shipping.shippingBreakdown = shipping.shippingBreakdown.map((p) => (
      String(p.vendor) === String(q.promotion.vendor) && (!q.promotion.store || !p.store || String(p.store) === String(q.promotion.store))
        ? { ...p, originalFee: p.fee, fee: 0 } : p
    ));
    shipping.shippingFee = shipping.shippingBreakdown.reduce((t, p) => t + Number(p.fee || 0), 0);
  }
  return {
    coupon: { code: q.code, promotion: q.promotion._id, vendor: q.promotion.vendor, type: q.type },
    discountAmount: q.discount,
    itemDiscount: q.itemDiscount,
  };
}

// Count one use; fails if the last use was just taken. Optimistic: the
// increment only lands if usedCount is still what we read.
async function redeem(promotionId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const promo = await Promotion.findById(promotionId);
    if (!promo) throw fail("This coupon code doesn't exist.", 404);
    if (promo.usageLimit && promo.usedCount >= promo.usageLimit) break;
    const updated = await Promotion.findOneAndUpdate(
      { _id: promotionId, usedCount: promo.usedCount },
      { $inc: { usedCount: 1 } },
      { new: true },
    );
    if (updated) return updated;
  }
  throw fail("This code has just reached its usage limit.", 409);
}

// Give the use back when an order using the code is cancelled.
async function release(order) {
  if (!order?.coupon?.promotion) return;
  await Promotion.updateOne({ _id: order.coupon.promotion, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } }).catch(() => {});
}

// Redemptions, discount given and sales per promotion, for the seller's table.
async function stats(promotionIds) {
  if (!promotionIds.length) return new Map();
  const orders = await Order.find({ "coupon.promotion": { $in: promotionIds } });
  const out = new Map();
  for (const o of orders) {
    const k = String(o.coupon.promotion);
    const s = out.get(k) || { orders: 0, paidOrders: 0, discountGiven: 0, sales: 0 };
    const counted = !["CANCELLED", "FAILED"].includes(o.orderStatus);
    if (counted) {
      s.orders += 1;
      if (o.paymentStatus === "PAID") s.paidOrders += 1;
      s.discountGiven += Number(o.discountAmount || 0);
      s.sales += (o.items || [])
        .filter((i) => String(i.vendor) === String(o.coupon.vendor))
        .reduce((t, i) => t + Number(i.price) * Number(i.quantity) - Number(i.discount || 0), 0);
    }
    out.set(k, s);
  }
  return out;
}

module.exports = { effectiveStatus, quote, applyToOrder, redeem, release, stats };
