const { readPin } = require("../config/delivery");
const orm = require("../database/orm");
const Order = require("../models/Order");
const Product = require("../models/Product");
const { normalizePhone } = require("../utils/sms.util");
const { effectivePrice, dealOn } = require("../utils/pricing.util");
const variantService = require("./variant.service");
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
const generateDeliveryOtp = () => require("crypto").randomInt(100000, 1000000).toString();

// Name and phone of the person receiving (or collecting) the order.
function parseRecipient(recipient = {}, role = "receiving the order") {
  const name = clean(recipient.name, 120);
  if (name.length < 2) throw httpError(400, `Enter the name of the person ${role}.`);
  const phone = normalizePhone(recipient.phone);
  if (!phone) throw httpError(400, "Enter a valid Rwandan phone number, for example 0788 123 456.");
  const email = clean(recipient.email, 160).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, "Enter a valid email address or leave it empty.");
  return { name, phone, email: email || undefined };
}

/**
 * Validate and normalise the delivery details sent by the checkout form.
 * Accepts the current shape ({ street, district, sector, province }) and the
 * legacy one ({ street, city, state }) so older clients keep working.
 */
function parseDelivery({ shippingAddress = {}, recipient = {}, deliveryMethod, shippingMethod }) {
  const requested = String(shippingMethod || deliveryMethod || "standard").toLowerCase();
  const method = DELIVERY_METHODS[requested] ? requested : "standard";
  const contact = parseRecipient(recipient, "collecting the order");

  // Pickup: the buyer collects from the store, so no delivery address.
  if (method === "pickup") {
    return {
      shippingAddress: { street: "Store pickup", city: "Pickup", country: "Rwanda" },
      recipient: contact,
      deliveryMethod: method,
      shippingMethod: DELIVERY_METHODS[method],
    };
  }

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
      ...(readPin(shippingAddress, { label: "delivery pin" }) || {}),
    },
    recipient: contact,
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
    // "productId~variantId" (as cart lines are keyed), or productId plus variantId.
    const key = variantService.parseKey(line?.productId);
    const productId = key.productId;
    const variantId = line?.variantId ? String(line.variantId) : key.variantId;
    if (!orm.isValidObjectId(productId)) throw httpError(400, "Every checkout item must reference a valid product.");
    if (variantId && !orm.isValidObjectId(variantId)) throw httpError(400, "Choose one of the product's sizes or colours.");
    const qty = Number(line.quantity ?? line.qty);
    if (!Number.isInteger(qty) || qty < 1) throw httpError(400, "Product quantity must be a positive whole number.");
    const k = variantService.keyOf(productId, variantId);
    const prev = merged.get(k);
    merged.set(k, { productId, variantId, quantity: (prev?.quantity || 0) + qty });
  }
  for (const { quantity } of merged.values()) {
    if (quantity > MAX_QTY_PER_LINE) throw httpError(400, `You can order at most ${MAX_QTY_PER_LINE} units of a product at once.`);
  }
  return [...merged.values()];
}

async function restoreStock(lines) {
  for (const { product, variant, quantity, deal } of lines) {
    if (variant) await variantService.giveBack(variant, quantity);
    if (deal) await Product.updateOne({ _id: product, dealSold: { $gte: quantity } }, { $inc: { dealSold: -quantity } });
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
// Low-stock alert: tell the seller once, when an order takes a product down to
// (or below) its low-stock level. A Premium tool while plans are on; everyone
// gets it while they are off.
async function lowStockAlert(product, sold) {
  const threshold = Number(product.lowStockThreshold ?? 5);
  const now = Number(product.stockQuantity) || 0;
  if (!(threshold > 0) || now > threshold || now + Number(sold) <= threshold) return;
  const ent = await require("./plans.service").entitlements(product.vendor);
  if (!ent.features.lowStockAlerts) return;
  await require("./sellerFinance.service").notify(
    product.vendor,
    now <= 0 ? `${product.name} is sold out` : `${product.name} is running low`,
    now <= 0 ? "The last units were just ordered. Restock it to keep selling." : `Only ${now} left after the latest order. Restock soon so buyers can keep ordering.`,
    String(product._id),
    "STOCK",
  );
}

async function reserveStock(lines) {
  const reserved = [];
  try {
    for (const line of lines) {
      const gone = () => httpError(409, `${line.name}${line.variantLabel ? ` (${line.variantLabel})` : ""} is no longer available in the quantity you selected. Please update your cart.`);
      // The size/colour first: its own stock is what runs out.
      if (line.variant && !(await variantService.take(line.variant, line.quantity))) throw gone();
      // Deal units are limited: take them only while the deal has units left.
      // Count first, then check: an order that pushes the count past the cap undoes itself.
      if (line.deal) {
        await Product.updateOne({ _id: line.product }, { $inc: { dealSold: line.quantity } });
        const fresh = await Product.findById(line.product).select("dealQuantity dealSold").lean();
        if (fresh.dealQuantity !== null && fresh.dealQuantity !== undefined && fresh.dealSold > fresh.dealQuantity) {
          await Product.updateOne({ _id: line.product }, { $inc: { dealSold: -line.quantity } });
          if (line.variant) await variantService.giveBack(line.variant, line.quantity);
          throw httpError(409, `The deal on ${line.name} just sold out. Refresh to see the current price.`);
        }
      }
      const updated = await Product.findOneAndUpdate(
        { _id: line.product, status: "ACTIVE", stockQuantity: { $gte: line.quantity } },
        { $inc: { stockQuantity: -line.quantity } },
        { new: true }
      );
      if (!updated) {
        if (line.variant) await variantService.giveBack(line.variant, line.quantity);
        if (line.deal) await Product.updateOne({ _id: line.product }, { $inc: { dealSold: -line.quantity } });
        throw gone();
      }
      reserved.push(line);
      lowStockAlert(updated, line.quantity).catch(() => {});
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
// Guest buyers (phone verified, no account password) get tighter limits:
// unpaid orders hold stock, so a guest can only have a few waiting at once,
// and one order can't exceed a set value. Both are configurable.
const GUEST_MAX_UNPAID_ORDERS = Number(process.env.GUEST_MAX_UNPAID_ORDERS || 2);
const GUEST_MAX_ORDER_AMOUNT = Number(process.env.GUEST_MAX_ORDER_AMOUNT || 2000000);

async function createOrder({ userId, lines: rawLines, delivery, paymentMethod, visitorId, couponCode }) {
  const parsed = parseDelivery(delivery);
  const lines = normaliseLines(rawLines);

  const User = require("../models/User");
  const buyer = await User.findById(userId).select("isGuest");
  const isGuest = Boolean(buyer?.isGuest);
  if (isGuest) {
    const waiting = await Order.countDocuments({ user: userId, paymentStatus: "PENDING", orderStatus: "PENDING" });
    if (waiting >= GUEST_MAX_UNPAID_ORDERS) {
      throw httpError(429, "You already have orders waiting for payment. Pay for them or cancel them in My orders before placing another.");
    }
  }

  const products = await Product.find({ _id: { $in: lines.map((l) => l.productId) } });
  const byId = new Map(products.map((p) => [p._id.toString(), p]));
  const variantsOf = await variantService.byProduct(products.map((p) => p._id));

  const orderItems = [];
  let subtotal = 0;
  for (const { productId, variantId, quantity } of lines) {
    const product = byId.get(productId);
    if (!product || product.status !== "ACTIVE") {
      throw httpError(400, `${product?.name || "A product in your order"} is no longer available.`);
    }
    if (product.vendor && product.vendor.toString() === String(userId)) {
      throw httpError(403, "You cannot buy your own product.");
    }
    // A product with sizes/colours is bought as one of them.
    const options = variantsOf.get(productId) || [];
    const variant = variantId ? options.find((v) => String(v._id) === variantId) : null;
    if (options.length && !variant) {
      throw httpError(400, variantId ? `That option of ${product.name} is no longer sold. Choose another.` : `Choose a size or colour for ${product.name}.`);
    }
    if (!options.length && variantId) throw httpError(400, `${product.name} has no sizes or colours to choose from. Remove it and add it again.`);
    const inStock = variant ? Number(variant.stockQuantity) : product.stockQuantity;
    if (inStock < quantity) {
      throw httpError(400, `Only ${inStock} of ${product.name}${variant ? ` (${variant.label})` : ""} left in stock.`);
    }
    const price = variantService.priceOf(product, variant);
    // A deal price (only for the product's own price, not a variant's own).
    const deal = (!variant || variant.price === null || variant.price === undefined) && dealOn(product);
    subtotal += price * quantity;
    orderItems.push({
      product: product._id,
      vendor: product.vendor || null,
      category: product.category || undefined,
      name: product.name,
      variant: variant?._id || null,
      variantLabel: variant?.label || null,
      deal: Boolean(deal),
      price,
      quantity,
      image: variant?.image || product.media?.mainImage || "",
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

  if (isGuest && subtotal - itemDiscount + shippingFee > GUEST_MAX_ORDER_AMOUNT) {
    throw httpError(400, `Guest orders are limited to RWF ${GUEST_MAX_ORDER_AMOUNT.toLocaleString("en-US")}. Create an account with a password to place a larger order.`);
  }

  const stockLines = orderItems.map((i) => ({ product: i.product, variant: i.variant, variantLabel: i.variantLabel, deal: i.deal, quantity: i.quantity, name: i.name }));
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
