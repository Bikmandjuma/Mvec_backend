const orm = require("../database/orm");
const Order = require("../models/Order");
const Product = require("../models/Product");
const { normalizePhone } = require("../utils/sms.util");
const { effectivePrice } = require("../utils/pricing.util");
const affiliateAttribution = require("./affiliateAttribution.service");
const { PROVINCES, RWANDA_LOCATIONS, provinceOfDistrict } = require("../config/rwandaLocations");
const shippingService = require("./shipping.service");
const promotionService = require("./promotion.service");

// Buyers pick a delivery speed; sellers price it with their shipping zones.
const DELIVERY_METHODS = { standard: "STANDARD", express: "EXPRESS", pickup: "PICKUP" };

const MAX_QTY_PER_LINE = 100;
const PAYMENT_METHODS = ["MOMO", "AIRTEL"];

const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const clean = (value, max = 200) => (typeof value === "string" ? value.trim().slice(0, max) : "");

const generateOrderNumber = () => `ORD-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
const generateDeliveryOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

/**
 * Validate and normalise the delivery details sent by the checkout form.
 * Accepts the current shape ({ street, district, sector, province }) and the
 * legacy one ({ street, city, state }) so older clients keep working.
 */
function parseDelivery({ shippingAddress = {}, recipient = {}, deliveryMethod, shippingMethod }) {
  const street = clean(shippingAddress.street || shippingAddress.address);
  const districtInput = clean(shippingAddress.district || shippingAddress.city, 80);
  const sector = clean(shippingAddress.sector, 80);
  const provinceInput = clean(shippingAddress.province || shippingAddress.state, 80);

  if (street.length < 3) throw httpError(400, "Enter your street, house number or a nearby landmark so the courier can find you.");
  if (!districtInput) throw httpError(400, "Choose the district you want the order delivered to.");
  const province = provinceOfDistrict(districtInput) || provinceInput;
  if (!PROVINCES.includes(province)) throw httpError(400, "Choose a valid province.");
  // Use the official district spelling; reject a district from another province.
  const district = (RWANDA_LOCATIONS[province] || []).find((d) => d.toLowerCase() === districtInput.toLowerCase());
  if (!district) throw httpError(400, `${districtInput} is not a district of ${province}. Choose your district from the list.`);

  const requested = String(shippingMethod || deliveryMethod || "standard").toLowerCase();
  const method = DELIVERY_METHODS[requested] ? requested : "standard";

  const name = clean(recipient.name, 120);
  if (name.length < 2) throw httpError(400, "Enter the name of the person receiving the order.");
  const phone = normalizePhone(recipient.phone);
  if (!phone) throw httpError(400, "Enter a valid Rwandan phone number for delivery, for example 0788 123 456.");
  const email = clean(recipient.email, 160).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, "Enter a valid email address or leave it empty.");

  return {
    shippingAddress: {
      street,
      city: district,
      district,
      sector: sector || undefined,
      province,
      state: province,
      country: "Rwanda",
      postalCode: clean(shippingAddress.postalCode, 20) || undefined,
    },
    recipient: { name, phone, email: email || undefined },
    deliveryMethod: method,
    shippingMethod: DELIVERY_METHODS[method],
  };
}

/**
 * Merge duplicate product lines and validate quantities.
 * @param {{productId: string, quantity: number}[]} rawLines
 */
function normaliseLines(rawLines) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) throw httpError(400, "Your cart is empty.");
  const merged = new Map();
  for (const line of rawLines) {
    const productId = String(line?.productId || "");
    if (!orm.isValidObjectId(productId)) throw httpError(400, "Every checkout item must reference a valid product.");
    const qty = Number(line.quantity ?? line.qty);
    if (!Number.isInteger(qty) || qty < 1) throw httpError(400, "Product quantity must be a positive whole number.");
    merged.set(productId, (merged.get(productId) || 0) + qty);
  }
  for (const qty of merged.values()) {
    if (qty > MAX_QTY_PER_LINE) throw httpError(400, `You can order at most ${MAX_QTY_PER_LINE} units of a product at once.`);
  }
  return [...merged.entries()].map(([productId, quantity]) => ({ productId, quantity }));
}

async function restoreStock(lines) {
  for (const { product, quantity } of lines) {
    await Product.updateOne({ _id: product }, { $inc: { stockQuantity: quantity } });
    await Product.updateOne(
      { _id: product, status: "OUT_OF_STOCK", stockQuantity: { $gt: 0 } },
      { $set: { status: "ACTIVE" } }
    );
  }
}

/**
 * Decrement stock atomically. Each update only succeeds when enough stock is
 * left, so two buyers can never both take the last unit. If any line fails,
 * the lines already reserved are put back.
 */
async function reserveStock(lines) {
  const reserved = [];
  try {
    for (const line of lines) {
      const updated = await Product.findOneAndUpdate(
        { _id: line.product, status: "ACTIVE", stockQuantity: { $gte: line.quantity } },
        { $inc: { stockQuantity: -line.quantity } },
        { new: true }
      );
      if (!updated) {
        throw httpError(409, `${line.name} is no longer available in the quantity you selected. Please update your cart.`);
      }
      reserved.push(line);
      if (updated.stockQuantity <= 0) {
        await Product.updateOne(
          { _id: updated._id, stockQuantity: { $lte: 0 } },
          { $set: { status: "OUT_OF_STOCK", stockQuantity: 0 } }
        );
      }
    }
  } catch (error) {
    await restoreStock(reserved);
    throw error;
  }
}

/**
 * Create a PENDING order for a buyer from product lines. Prices, shipping and
 * totals are computed here, never trusted from the client.
 */
async function createOrder({ userId, lines: rawLines, delivery, paymentMethod, visitorId, couponCode }) {
  const parsed = parseDelivery(delivery);
  const lines = normaliseLines(rawLines);

  const products = await Product.find({ _id: { $in: lines.map((l) => l.productId) } });
  const byId = new Map(products.map((p) => [p._id.toString(), p]));

  const orderItems = [];
  let subtotal = 0;
  for (const { productId, quantity } of lines) {
    const product = byId.get(productId);
    if (!product || product.status !== "ACTIVE") {
      throw httpError(400, `${product?.name || "A product in your order"} is no longer available.`);
    }
    if (product.vendor && product.vendor.toString() === String(userId)) {
      throw httpError(403, "You cannot buy your own product.");
    }
    if (product.stockQuantity < quantity) {
      throw httpError(400, `Only ${product.stockQuantity} of ${product.name} left in stock.`);
    }
    const price = effectivePrice(product);
    subtotal += price * quantity;
    orderItems.push({
      product: product._id,
      vendor: product.vendor || null,
      category: product.category || undefined,
      name: product.name,
      price,
      quantity,
      image: product.media?.mainImage || "",
    });
  }

  // Delivery is priced by each seller's shipping zones (per store parcel).
  const quote = await shippingService.quoteShipping({
    lines: orderItems.map((i) => ({ product: byId.get(String(i.product)), quantity: i.quantity, price: i.price })),
    address: parsed.shippingAddress,
    method: parsed.shippingMethod,
  });
  if (!quote.deliverable) {
    throw httpError(400, `${quote.groups.filter((g) => !g.deliverable).map((g) => g.message).join(" ")} Remove those items or choose another address.`);
  }
  let shippingFee = quote.shippingFee;
  let shippingBreakdown = quote.groups.map((g) => ({
    vendor: g.vendor, store: g.store, storeName: g.storeName, zone: g.zone, zoneName: g.zoneName,
    method: g.method, fee: g.fee, eta: g.eta,
  }));

  // Seller coupon, validated here (never trusted from the client). Item
  // discounts are stored per line and borne by that seller in the settlement;
  // a free-delivery coupon zeroes that seller's parcel fee.
  let couponFields = {};
  let itemDiscount = 0;
  let promotionId = null;
  if (couponCode) {
    const couponQuote = await promotionService.quote(couponCode, {
      lines: orderItems.map((i) => ({ product: byId.get(String(i.product)), quantity: i.quantity, price: i.price })),
      parcels: shippingBreakdown,
      userId,
    });
    const shipping = { shippingBreakdown, shippingFee };
    const applied = promotionService.applyToOrder(couponQuote, orderItems, shipping);
    ({ shippingBreakdown, shippingFee } = shipping);
    couponFields = { coupon: applied.coupon, discountAmount: applied.discountAmount };
    itemDiscount = applied.itemDiscount;
    promotionId = couponQuote.promotion._id;
  }

  // Last-click affiliate attribution, resolved from server-side click records
  // (never from client-supplied affiliate data).
  const attributions = await affiliateAttribution.resolveAttributions({
    visitorId,
    buyerId: userId,
    productIds: orderItems.map((i) => i.product),
  });
  orderItems.forEach((i) => affiliateAttribution.applyAttribution(i, attributions.get(String(i.product))));

  const stockLines = orderItems.map((i) => ({ product: i.product, quantity: i.quantity, name: i.name }));
  await reserveStock(stockLines);
  if (promotionId) {
    try { await promotionService.redeem(promotionId); } catch (error) { await restoreStock(stockLines); throw error; }
  }

  try {
    return await Order.create({
      user: userId,
      orderNumber: generateOrderNumber(),
      items: orderItems,
      shippingAddress: parsed.shippingAddress,
      recipient: parsed.recipient,
      deliveryMethod: parsed.deliveryMethod,
      shippingMethod: quote.method === "PICKUP" ? "PICKUP" : parsed.shippingMethod,
      shippingBreakdown,
      subtotal,
      shippingFee,
      totalAmount: subtotal - itemDiscount + shippingFee,
      ...couponFields,
      paymentMethod: PAYMENT_METHODS.includes(paymentMethod) ? paymentMethod : "MOMO",
      paymentStatus: "PENDING",
      orderStatus: "PENDING",
      deliveryOtp: generateDeliveryOtp(),
    });
  } catch (error) {
    await restoreStock(stockLines);
    if (promotionId) await promotionService.release({ coupon: { promotion: promotionId } });
    throw error;
  }
}

module.exports = {
  createOrder,
  restoreStock,
  generateDeliveryOtp,
  httpError,
};
