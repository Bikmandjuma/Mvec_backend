// End-to-end checks for the buyer journey: sign-up, cart, checkout, payment,
// cancellation, expiry, disputes and the public catalogue. Runs against an
// in-memory MongoDB replica set (transactions need one), never a real DB.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "buyer_flow_test_secret";
delete process.env.PAYPACK_CLIENT_ID;
delete process.env.PAYPACK_CLIENT_SECRET;

const User = require("../src/models/User");
const Product = require("../src/models/Product");
const Cart = require("../src/models/Cart");
const Order = require("../src/models/Order");
const Payment = require("../src/models/Payment");
const Settlement = require("../src/models/Settlement");
const VendorWallet = require("../src/models/VendorWallet");
const Vendor = require("../src/models/Vendor");
const Review = require("../src/models/Review");
const Category = require("../src/models/Category");
const { cancelExpiredUnpaidOrders } = require("../src/workers/slaWorker");

let replSet;
let app;
let buyer, otherBuyer, vendorUser;
let buyerToken, otherToken, vendorToken;
let product, pricey;

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const tokenFor = (user) => jwt.sign({ id: user._id.toString(), userId: user._id.toString() }, process.env.JWT_SECRET);

const delivery = {
  shippingAddress: { street: "KG 11 Ave 18", district: "Gasabo", sector: "Remera", province: "Kigali City" },
  recipient: { name: "Aline Uwase", phone: "0788123456", email: "aline@example.com" },
  deliveryMethod: "standard",
};

before(async () => {
  replSet = await MongoMemoryReplSet.create({ binary: { version: "7.0.0" }, replSet: { count: 1 } });
  await mongoose.connect(replSet.getUri());
  app = express();
  app.use(express.json());
  app.use("/api/auth", require("../src/routes/auth.routes"));
  app.use("/api/products", require("../src/routes/product.routes"));
  app.use("/api/cart", require("../src/routes/cart.routes"));
  app.use("/api/orders", require("../src/routes/order.routes"));
  app.use("/api/payments", require("../src/routes/payment.routes"));
  app.use("/api/disputes", require("../src/routes/dispute.routes"));
  app.use("/api/vendors", require("../src/routes/vendor.routes"));
  app.use("/api/reviews", require("../src/routes/review.routes"));
});

after(async () => {
  await mongoose.disconnect();
  await replSet.stop();
});

beforeEach(async () => {
  await mongoose.connection.db.dropDatabase();
  await Promise.all([Order.syncIndexes(), Payment.syncIndexes(), User.syncIndexes()]);
  vendorUser = await User.create({ Fullname: "Kigali Tech", password: "x", phone: "+250788000001", role: "vendor", companyName: "Kigali Tech" });
  buyer = await User.create({ Fullname: "Aline Uwase", password: "x", phone: "+250788000002", role: "buyer" });
  otherBuyer = await User.create({ Fullname: "Jean Paul", password: "x", phone: "+250788000003", role: "buyer" });
  [buyerToken, otherToken, vendorToken] = [buyer, otherBuyer, vendorUser].map(tokenFor);
  const category = await Category.create({ name: "Electronics", slug: "electronics" });
  const base = { vendor: vendorUser._id, category: category._id, description: "Test product", media: { mainImage: "/uploads/x.jpg" }, status: "ACTIVE" };
  product = await Product.create({ ...base, name: "Headphones", price: 70000, discountPrice: 60000, stockQuantity: 2 });
  pricey = await Product.create({ ...base, name: "Camera", price: 1500000, stockQuantity: 5 });
});

test("sign-up refuses privileged roles and accepts an empty gender", async () => {
  const admin = await request(app).post("/api/auth/register").send({ Fullname: "Mallory", password: "password123", phone: "0788111111", role: "super_admin" });
  assert.equal(admin.status, 400);
  assert.equal(await User.countDocuments({ role: "super_admin" }), 0);

  const shortPw = await request(app).post("/api/auth/register").send({ Fullname: "Eric", password: "short", phone: "0788111112", role: "buyer" });
  assert.equal(shortPw.status, 400);

  const ok = await request(app).post("/api/auth/register").send({ Fullname: "Eric M", password: "password123", phone: "0788111113", role: "buyer", gender: "" });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test("profile can be updated but not the role", async () => {
  const res = await request(app).patch("/api/auth/me").set(auth(buyerToken)).send({ Fullname: "Aline U.", email: "ALINE@example.com", gender: "female", role: "super_admin" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const fresh = await User.findById(buyer._id);
  assert.equal(fresh.Fullname, "Aline U.");
  assert.equal(fresh.email, "aline@example.com");
  assert.equal(fresh.role, "buyer");
});

test("public catalogue hides drafts and vendor emails", async () => {
  await Product.create({ ...(await Product.findById(product._id).lean()), _id: undefined, slug: undefined, sku: undefined, publicId: undefined, name: "Secret draft", status: "DRAFT" });
  const list = await request(app).get("/api/products?status=DRAFT");
  assert.equal(list.status, 200);
  assert.ok(list.body.products.every((p) => p.status === "ACTIVE"));
  assert.ok(list.body.products.every((p) => !p.vendor?.email));
  const one = await request(app).get(`/api/products/${product._id}`);
  assert.equal(one.status, 200);
});

test("public vendors expose id and userId but not the commission rate", async () => {
  await Vendor.create({ user: vendorUser._id, businessName: "Kigali Tech", phone: "0788000001", email: "v@x.rw", status: "ACTIVE", verificationStatus: "VERIFIED", commissionRate: 12 });
  const res = await request(app).get("/api/vendors?q=(((");
  assert.equal(res.status, 200);
  const res2 = await request(app).get("/api/vendors");
  const [v] = res2.body.data;
  assert.ok(v.id && v.userId);
  assert.equal(v.commissionRate, undefined);
});

test("checkout charges discounted price plus delivery and reserves stock", async () => {
  await request(app).post("/api/cart").set(auth(buyerToken)).send({ productId: String(product._id), quantity: 2 }).expect(200);

  const bad = await request(app).post("/api/orders/checkout").set(auth(buyerToken)).send({ ...delivery, recipient: { name: "A", phone: "123" } });
  assert.equal(bad.status, 400);

  const res = await request(app).post("/api/orders/checkout").set(auth(buyerToken))
    .send({ ...delivery, shippingAddress: { ...delivery.shippingAddress, district: "Musanze", province: "Northern Province" } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const { order } = res.body;
  assert.ok(order.id, "orders expose id");
  assert.equal(order.subtotal, 120000);
  assert.equal(order.shippingFee, 5000);
  assert.equal(order.totalAmount, 125000);
  assert.equal(order.recipient.phone, "+250788123456");
  assert.equal(order.shippingAddress.province, "Northern Province");
  assert.ok(order.deliveryOtp);

  const p = await Product.findById(product._id);
  assert.equal(p.stockQuantity, 0);
  assert.equal(p.status, "OUT_OF_STOCK");
  assert.equal((await Cart.findOne({ user: buyer._id })).items.length, 0);
});

test("two buyers cannot both buy the last units", async () => {
  const lines = [{ productId: String(product._id), quantity: 2 }];
  const [a, b] = await Promise.all([
    request(app).post("/api/orders/direct-checkout").set(auth(buyerToken)).send({ ...delivery, items: lines }),
    request(app).post("/api/orders/direct-checkout").set(auth(otherToken)).send({ ...delivery, items: lines }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  assert.equal((await Product.findById(product._id)).stockQuantity, 0);
});

test("vendors cannot buy their own products and cannot see the delivery code", async () => {
  const own = await request(app).post("/api/orders/direct-checkout").set(auth(vendorToken)).send({ ...delivery, items: [{ productId: String(product._id), quantity: 1 }] });
  assert.equal(own.status, 403);

  const res = await request(app).post("/api/orders/direct-checkout").set(auth(buyerToken)).send({ ...delivery, items: [{ productId: String(product._id), quantity: 1 }] });
  const id = res.body.order.id;
  const asVendor = await request(app).get(`/api/orders/${id}`).set(auth(vendorToken));
  assert.equal(asVendor.status, 200);
  assert.equal(asVendor.body.order.deliveryOtp, undefined);
  const asOther = await request(app).get(`/api/orders/${id}`).set(auth(otherToken));
  assert.equal(asOther.status, 403);
});

test("sandbox payment goes through escrow, blocks duplicates, then cancel refunds", async () => {
  const res = await request(app).post("/api/orders/direct-checkout").set(auth(buyerToken)).send({ ...delivery, items: [{ productId: String(product._id), quantity: 1 }] });
  const id = res.body.order.id;

  const stranger = await request(app).post("/api/payments/pay").set(auth(otherToken)).send({ orderId: id, phoneNumber: "0788123456" });
  assert.equal(stranger.status, 404);

  const airtel = await request(app).post("/api/payments/pay").set(auth(buyerToken)).send({ orderId: id, phoneNumber: "0731234567" });
  assert.equal(airtel.status, 200, JSON.stringify(airtel.body));
  assert.equal(airtel.body.status, "SUCCESS");

  const order = await Order.findById(id);
  assert.equal(order.paymentStatus, "PAID");
  assert.ok(order.paidAt);
  assert.equal(await Settlement.countDocuments({ order: id, status: "HELD" }), 1);

  const again = await request(app).post("/api/payments/pay").set(auth(buyerToken)).send({ orderId: id, phoneNumber: "0788123456" });
  assert.equal(again.status, 400);

  const walletBefore = await VendorWallet.findOne({ vendor: vendorUser._id });
  assert.ok(walletBefore.pendingBalance > 0);

  const cancel = await request(app).post(`/api/orders/${id}/cancel`).set(auth(buyerToken));
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
  const after = await Order.findById(id);
  assert.equal(after.orderStatus, "CANCELLED");
  assert.equal(after.paymentStatus, "REFUNDED");
  assert.equal(await Settlement.countDocuments({ order: id, status: "REFUNDED" }), 1);
  assert.equal((await VendorWallet.findOne({ vendor: vendorUser._id })).pendingBalance, 0);
  assert.equal((await Product.findById(product._id)).stockQuantity, 2);
});

test("duplicate payment prompts within two minutes are refused", async () => {
  const res = await request(app).post("/api/orders/direct-checkout").set(auth(buyerToken)).send({ ...delivery, items: [{ productId: String(product._id), quantity: 1 }] });
  const id = res.body.order.id;
  await Payment.create({ parentOrder: id, transactionReference: "T1", method: "MOMO", provider: "MTN", amount: 60000, status: "PENDING" });
  const dup = await request(app).post("/api/payments/pay").set(auth(buyerToken)).send({ orderId: id, phoneNumber: "0788123456" });
  assert.equal(dup.status, 409);
  assert.ok(dup.body.paymentId);
});

test("unpaid orders can be cancelled and expire after 30 minutes", async () => {
  const a = await request(app).post("/api/orders/direct-checkout").set(auth(buyerToken)).send({ ...delivery, items: [{ productId: String(product._id), quantity: 1 }] });
  const cancel = await request(app).post(`/api/orders/${a.body.order.id}/cancel`).set(auth(buyerToken));
  assert.equal(cancel.status, 200);
  assert.equal((await Product.findById(product._id)).stockQuantity, 2);

  const b = await request(app).post("/api/orders/direct-checkout").set(auth(buyerToken)).send({ ...delivery, items: [{ productId: String(product._id), quantity: 2 }] });
  assert.equal((await Product.findById(product._id)).status, "OUT_OF_STOCK");
  await Order.collection.updateOne({ _id: new mongoose.Types.ObjectId(b.body.order.id) }, { $set: { createdAt: new Date(Date.now() - 31 * 60 * 1000) } });
  await cancelExpiredUnpaidOrders();
  const expired = await Order.findById(b.body.order.id);
  assert.equal(expired.orderStatus, "CANCELLED");
  const p = await Product.findById(product._id);
  assert.equal(p.stockQuantity, 2);
  assert.equal(p.status, "ACTIVE");

  const late = await request(app).post("/api/payments/pay").set(auth(buyerToken)).send({ orderId: b.body.order.id, phoneNumber: "0788123456" });
  assert.equal(late.status, 400);
});

test("only the buyer can open a dispute, and only on a paid order", async () => {
  const res = await request(app).post("/api/orders/direct-checkout").set(auth(buyerToken)).send({ ...delivery, items: [{ productId: String(pricey._id), quantity: 1 }] });
  const id = res.body.order.id;
  const payload = { orderId: id, reason: "DAMAGED_GOODS", description: "The lens arrived cracked." };

  assert.equal((await request(app).post("/api/disputes").set(auth(buyerToken)).send(payload)).status, 400);
  await request(app).post("/api/payments/pay").set(auth(buyerToken)).send({ orderId: id, phoneNumber: "0788123456" }).expect(200);
  assert.equal((await request(app).post("/api/disputes").set(auth(otherToken)).send(payload)).status, 400);
  const ok = await request(app).post("/api/disputes").set(auth(buyerToken)).send(payload);
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal((await Order.findById(id)).paymentStatus, "DISPUTED");
  assert.equal((await request(app).post(`/api/orders/${id}/cancel`).set(auth(buyerToken))).status, 400);
});

test("reviews from the order page are accepted after delivery and hide emails publicly", async () => {
  const res = await request(app).post("/api/orders/direct-checkout").set(auth(buyerToken)).send({ ...delivery, items: [{ productId: String(product._id), quantity: 1 }] });
  await Order.updateOne({ _id: res.body.order.id }, { orderStatus: "DELIVERED", paymentStatus: "PAID" });
  const created = await request(app).post("/api/reviews").set(auth(buyerToken)).send({ product: String(product._id), rating: 5, reviewText: "Great sound" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const list = await request(app).get(`/api/reviews/product/${product._id}`);
  assert.equal(list.body.reviews.length, 1);
  assert.equal(list.body.reviews[0].email, undefined);
  assert.equal(await Review.countDocuments(), 1);
});
