require("../helpers/jest-shim"); // Jest-style API on node:test
const db = require("../helpers/mysql"); // MySQL test database (first, before models)
const request = require("supertest");
const jwt = require("jsonwebtoken");
const express = require("express");
const User = require("../../src/models/User");
const Vendor = require("../../src/models/Vendor");
const Store = require("../../src/models/Store");
const Product = require("../../src/models/Product");
const ProductVariant = require("../../src/models/ProductVariant");
const ProductAlert = require("../../src/models/ProductAlert");
const Notification = require("../../src/models/Notification");
const Order = require("../../src/models/Order");
const VendorWallet = require("../../src/models/VendorWallet");
const DeviceToken = require("../../src/models/DeviceToken");
const Category = require("../../src/models/Category");
const commission = require("../../src/services/commission.service");
const alerts = require("../../src/services/alerts.service");
const returnsService = require("../../src/services/returns.service");

jest.setTimeout(120000);

// Variants, flash deals, returns, alerts, badges and push devices.
describe("Marketplace features", () => {
  let app;
  let seller, buyer, admin, vendor, category, store;
  const tokens = {};
  const secret = "marketplace_features_secret";
  const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
  const delivery = {
    shippingAddress: { street: "KG 11 Ave 18", district: "Gasabo", sector: "Remera", province: "Kigali City" },
    recipient: { name: "Aline Uwase", phone: "0788123456" },
    deliveryMethod: "standard",
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = secret;
    delete process.env.PAYPACK_CLIENT_ID; // sandbox payments
    await db.setup();
    app = express();
    app.use(express.json());
    app.use("/api/products", require("../../src/routes/product.routes"));
    app.use("/api/cart", require("../../src/routes/cart.routes"));
    app.use("/api/orders", require("../../src/routes/order.routes"));
    app.use("/api/payments", require("../../src/routes/payment.routes"));
    app.use("/api/returns", require("../../src/routes/returns.routes"));
    app.use("/api/notifications", require("../../src/routes/notification.routes"));
    app.use("/api/vendors", require("../../src/routes/vendor.routes"));
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.reset();
    commission.clearCache();
    require("../../src/services/badge.service").clear();
    const make = (name, role, n) => User.create({ Fullname: name, companyName: name, email: `${role}${n}@example.com`, password: "password123", phone: `07880007${String(n).padStart(2, "0")}`, gender: "male", role, isOnboarded: true });
    seller = await make("Kigali Fashion", "vendor", 1);
    buyer = await make("Aline Buyer", "buyer", 2);
    admin = await make("Admin", "super_admin", 3);
    vendor = await Vendor.create({ user: seller._id, businessName: "Kigali Fashion", phone: "0788000701", email: "shop@example.com", description: "Clothes.", logoUrl: "/l.png", category: "Fashion", location: "Kigali", verificationStatus: "VERIFIED" });
    store = await Store.create({ vendor: seller._id, isPrimary: true, storeName: "Kigali Fashion", slug: "kigali-fashion", contactEmail: "shop@example.com", contactPhone: "0788000701", status: "ACTIVE" });
    category = await Category.create({ name: "Fashion", slug: "fashion" });
    for (const [k, u] of Object.entries({ seller, buyer, admin })) tokens[k] = jwt.sign({ userId: u._id }, secret);
  });

  const shirt = (extra = {}) => Product.create({ vendor: seller._id, store: store._id, category: category._id, name: "Cotton shirt", description: "A cotton shirt.", price: 10000, stockQuantity: 10, status: "ACTIVE", media: { mainImage: "/s.png", gallery: [] }, ...extra });
  const buy = async (items) => {
    const bought = await request(app).post("/api/orders/direct-checkout").set(as("buyer")).send({ ...delivery, items });
    return bought;
  };
  const pay = async (id) => expect((await request(app).post("/api/payments/pay").set(as("buyer")).send({ orderId: id, phoneNumber: "0788123456" })).body.status).toBe("SUCCESS");
  const deliver = async (id) => {
    expect((await request(app).patch("/api/orders/vendor/status").set(as("seller")).send({ orderId: id, status: "SHIPPED" })).status).toBe(200);
    const { deliveryOtp } = await Order.findById(id);
    expect((await request(app).patch(`/api/orders/${id}/deliver`).set(as("seller")).send({ deliveryOtp })).status).toBe(200);
  };

  test("variants: each size/colour has its own stock and price; checkout takes from that one", async () => {
    const p = await shirt();
    const set = await request(app).put(`/api/products/${p._id}/variants`).set(as("seller")).send({
      variants: [
        { options: { color: "Red", size: "M" }, stockQuantity: 2 },
        { options: { color: "Red", size: "XL" }, stockQuantity: 1, price: 12000 },
      ],
    });
    expect(set.status).toBe(200);
    expect(set.body.variantOptions.map((o) => o.name)).toEqual(["Color", "Size"]);
    expect((await Product.findById(p._id)).stockQuantity).toBe(3); // the sum
    const [m, xl] = set.body.variants;
    expect([m.label, xl.price]).toEqual(["Red / M", 12000]);

    // The product page lists them; the cart needs one.
    const page = await request(app).get(`/api/products/${p._id}`);
    expect(page.body.product.variants).toHaveLength(2);
    expect((await request(app).post("/api/cart").set(as("buyer")).send({ productId: String(p._id), quantity: 1 })).body.code).toBe("VARIANT_REQUIRED");
    const added = await request(app).post("/api/cart").set(as("buyer")).send({ productId: xl.key, quantity: 1 });
    expect(added.status).toBe(200);
    expect([added.body.cart.items[0].lineId, added.body.cart.items[0].variantLabel, added.body.cart.items[0].price]).toEqual([xl.key, "Red / XL", 12000]);
    expect((await request(app).put(`/api/cart/items/${encodeURIComponent(xl.key)}`).set(as("buyer")).send({ quantity: 2 })).status).toBe(400);

    // Only 1 XL: a second is refused; buying it takes the XL and the product total.
    expect((await buy([{ productId: xl.key, quantity: 2 }])).status).toBe(400);
    const order = await buy([{ productId: xl.key, quantity: 1 }]);
    expect(order.status).toBe(201);
    expect(order.body.order.items[0].variantLabel).toBe("Red / XL");
    expect(order.body.order.items[0].price).toBe(12000);
    expect((await ProductVariant.findById(xl.id)).stockQuantity).toBe(0);
    expect((await Product.findById(p._id)).stockQuantity).toBe(2);

    // Cancelling gives the XL back.
    expect((await request(app).post(`/api/orders/${order.body.order.id}/cancel`).set(as("buyer")).send({ reason: "Changed my mind" })).status).toBe(200);
    expect((await ProductVariant.findById(xl.id)).stockQuantity).toBe(1);
  });

  test("flash deals: the deal price applies while on, for its units only", async () => {
    const p = await shirt();
    const now = Date.now();
    const bad = await request(app).put(`/api/products/${p._id}`).set(as("seller")).send({ dealPrice: 11000, dealStartsAt: new Date(now - 60000), dealEndsAt: new Date(now + 3600000) });
    expect(bad.status).toBe(400);
    const ok = await request(app).put(`/api/products/${p._id}`).set(as("seller")).send({ dealPrice: 7000, dealStartsAt: new Date(now - 60000), dealEndsAt: new Date(now + 3600000), dealQuantity: 2 });
    expect(ok.status).toBe(200);
    const { price, live, left, percentOff } = ok.body.product.deal;
    expect({ price, live, left, percentOff }).toEqual({ price: 7000, live: true, left: 2, percentOff: 30 });

    const deals = await request(app).get("/api/products/deals");
    expect(deals.body.live.map((d) => String(d._id))).toEqual([String(p._id)]);

    const first = await buy([{ productId: String(p._id), quantity: 2 }]);
    expect(first.status).toBe(201);
    expect(first.body.order.items[0].price).toBe(7000);
    expect(first.body.order.items[0].deal).toBe(true);
    // Deal sold out: back to the regular price, and off the deals page.
    const second = await buy([{ productId: String(p._id), quantity: 1 }]);
    expect(second.body.order.items[0].price).toBe(10000);
    expect((await request(app).get("/api/products/deals")).body.live).toHaveLength(0);
  });

  test("returns: requested, approved, received; the buyer is refunded from the seller's balance", async () => {
    const p = await shirt();
    const order = (await buy([{ productId: String(p._id), quantity: 2 }])).body.order;
    await pay(order.id);
    // Not delivered yet: nothing to return.
    expect((await request(app).get(`/api/returns/orders/${order.id}/eligibility`).set(as("buyer"))).body.items[0].returnable).toBe(0);
    await deliver(order.id);
    const before = await VendorWallet.findOne({ vendor: seller._id });

    const elig = await request(app).get(`/api/returns/orders/${order.id}/eligibility`).set(as("buyer"));
    const [line] = elig.body.items;
    expect(line.returnable).toBe(2);
    // A damaged item needs a photo.
    expect((await request(app).post("/api/returns").set(as("buyer")).send({ orderId: order.id, items: [{ orderItemId: line.orderItemId, quantity: 1 }], reason: "DAMAGED", description: "The collar is torn." })).status).toBe(400);
    const asked = await request(app).post("/api/returns").set(as("buyer")).send({ orderId: order.id, items: [{ orderItemId: line.orderItemId, quantity: 1 }], reason: "DAMAGED", description: "The collar is torn.", photos: ["/uploads/torn.jpg"] });
    expect(asked.status).toBe(200);
    const ret = asked.body.returns[0];
    expect([ret.status, ret.refundAmount]).toEqual(["REQUESTED", 10000]);
    expect((await request(app).get(`/api/returns/orders/${order.id}/eligibility`).set(as("buyer"))).body.items[0].returnable).toBe(1);

    expect((await request(app).post(`/api/returns/${ret.id}/received`).set(as("seller")).send({})).status).toBe(409);
    expect((await request(app).post(`/api/returns/${ret.id}/approve`).set(as("seller")).send({ instructions: "Bring it to our shop in Remera." })).body.return.status).toBe("APPROVED");
    const done = await request(app).post(`/api/returns/${ret.id}/received`).set(as("seller")).send({ restock: true });
    expect(done.status).toBe(200);
    expect(done.body.return.status).toBe("REFUNDED");

    const after = await VendorWallet.findOne({ vendor: seller._id });
    const net = Number(before.availableBalance) - Number(after.availableBalance);
    expect(net > 0 && net <= 10000).toBe(true);
    expect((await Product.findById(p._id)).stockQuantity).toBe(9); // 10 - 2 + 1 back
    const titles = (await Notification.find({ recipient: buyer._id }).lean()).map((n) => n.title);
    expect(titles.some((t) => t.startsWith("Refund for return"))).toBe(true);
  });

  test("returns: a declined return goes to Ikiguzi, who can refund; an unanswered one escalates by itself", async () => {
    const p = await shirt();
    const order = (await buy([{ productId: String(p._id), quantity: 1 }])).body.order;
    await pay(order.id);
    await deliver(order.id);
    const [line] = (await request(app).get(`/api/returns/orders/${order.id}/eligibility`).set(as("buyer"))).body.items;
    const ret = (await request(app).post("/api/returns").set(as("buyer")).send({ orderId: order.id, items: [{ orderItemId: line.orderItemId, quantity: 1 }], reason: "DOES_NOT_FIT", description: "Too small for me." })).body.returns[0];

    expect((await request(app).post(`/api/returns/${ret.id}/escalate`).set(as("buyer")).send({})).status).toBe(409);
    expect((await request(app).post(`/api/returns/${ret.id}/reject`).set(as("seller")).send({ reason: "Worn and washed." })).body.return.status).toBe("REJECTED");
    expect((await request(app).post(`/api/returns/${ret.id}/escalate`).set(as("buyer")).send({ reason: "It was never worn." })).body.return.status).toBe("ESCALATED");
    expect((await request(app).post(`/api/returns/${ret.id}/decide`).set(as("seller")).send({ decision: "REFUND", note: "ok" })).status).toBe(403);
    const decided = await request(app).post(`/api/returns/${ret.id}/decide`).set(as("admin")).send({ decision: "REFUND", note: "The photos show it unworn." });
    expect(decided.body.return.status).toBe("REFUNDED");

    // Another order, never answered: Ikiguzi takes it after the deadline.
    const p2 = await shirt({ name: "Linen shirt" });
    const o2 = (await buy([{ productId: String(p2._id), quantity: 1 }])).body.order;
    await pay(o2.id);
    await deliver(o2.id);
    const [l2] = (await request(app).get(`/api/returns/orders/${o2.id}/eligibility`).set(as("buyer"))).body.items;
    await request(app).post("/api/returns").set(as("buyer")).send({ orderId: o2.id, items: [{ orderItemId: l2.orderItemId, quantity: 1 }], reason: "CHANGED_MIND", description: "Found a better one." });
    expect(await returnsService.escalateOverdue(new Date(Date.now() + 5 * 24 * 3600 * 1000))).toBe(1);
  });

  test("alerts: back in stock and price drops reach the buyer once", async () => {
    const p = await shirt({ stockQuantity: 0, status: "OUT_OF_STOCK" });
    expect((await request(app).post(`/api/products/${p._id}/alerts`).set(as("buyer")).send({ kind: "BACK_IN_STOCK" })).status).toBe(200);
    expect((await request(app).post(`/api/products/${p._id}/alerts`).set(as("buyer")).send({ kind: "PRICE_DROP" })).status).toBe(200);
    expect((await request(app).get(`/api/products/${p._id}/alerts`).set(as("buyer"))).body).toEqual({ BACK_IN_STOCK: true, PRICE_DROP: true });

    expect(await alerts.check()).toEqual({ backInStock: 0, priceDrops: 0 });
    await Product.updateOne({ _id: p._id }, { $set: { stockQuantity: 5, status: "ACTIVE", price: 8000 } });
    expect(await alerts.check()).toEqual({ backInStock: 1, priceDrops: 1 });
    expect(await alerts.check()).toEqual({ backInStock: 0, priceDrops: 0 });
    const titles = (await Notification.find({ recipient: buyer._id }).lean()).map((n) => n.title);
    expect(["Cotton shirt is back in stock", "Price drop: Cotton shirt"].every((t) => titles.includes(t))).toBe(true);
    expect(await ProductAlert.countDocuments({ user: buyer._id, active: true })).toBe(1); // price drop keeps watching
  });

  test("badges come from real numbers; devices register for push", async () => {
    const p = await shirt();
    const page = await request(app).get(`/api/products/${p._id}`);
    expect(page.body.product.sellerBadges.map((b) => b.code)).toEqual(["VERIFIED", "NEW_SELLER"]);
    const store = await request(app).get(`/api/vendors/${vendor._id}`);
    expect(store.body.vendor.badges.map((b) => b.code)).toContain("VERIFIED");

    const reg = await request(app).post("/api/notifications/devices").set(as("buyer")).send({ token: "f".repeat(40), platform: "android" });
    expect(reg.body).toEqual({ registered: true, pushEnabled: false });
    expect(await DeviceToken.countDocuments({ user: buyer._id })).toBe(1);
    await request(app).delete("/api/notifications/devices").set(as("buyer")).send({ token: "f".repeat(40) });
    expect(await DeviceToken.countDocuments({ user: buyer._id })).toBe(0);
  });
});
