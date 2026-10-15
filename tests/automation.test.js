// Automation and safety around the buyer and affiliate flows: password reset,
// session revocation, fulfilment rules, delivery codes, couriers, automatic
// refunds, notifications, disputes, wishlist and affiliate withdrawals.
// In-memory replica set; Paypack runs in simulation mode; SMS is captured.
const db = require("./helpers/mysql"); // first: selects the MySQL test database
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const orm = require("../src/database/orm");
const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "automation_test_secret";
process.env.SMS_PROVIDER = "log";
delete process.env.PAYPACK_CLIENT_ID;
delete process.env.PAYPACK_CLIENT_SECRET;
delete process.env.EMAIL_USER;

const messaging = require("../src/services/messaging.service");
const sentSms = [];
messaging.sendSms = async (phone, text) => { sentSms.push({ phone, text }); };

const User = require("../src/models/User");
const Product = require("../src/models/Product");
const Category = require("../src/models/Category");
const Order = require("../src/models/Order");
const Settlement = require("../src/models/Settlement");
const Notification = require("../src/models/Notification");
const Disbursement = require("../src/models/Disbursement");
const AffiliateWallet = require("../src/models/AffiliateWallet");
const AffiliatePayout = require("../src/models/AffiliatePayout");
const Dispute = require("../src/models/Dispute");
const { sendPaymentReminders } = require("../src/workers/slaWorker");

let app;
let buyer, vendor, vendorB, admin, courier, affiliate;
let product, productB;
const token = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET);
const auth = (u) => ({ Authorization: `Bearer ${token(u)}` });
const delivery = {
  shippingAddress: { street: "KG 11 Ave", district: "Gasabo", province: "Kigali City" },
  recipient: { name: "Aline Uwase", phone: "0788123456" },
};

before(async () => {
  await db.setup();
  app = express();
  app.use(express.json());
  app.use("/api/auth", require("../src/routes/auth.routes"));
  app.use("/api/orders", require("../src/routes/order.routes"));
  app.use("/api/payments", require("../src/routes/payment.routes"));
  app.use("/api/disputes", require("../src/routes/dispute.routes"));
  app.use("/api/affiliates", require("../src/routes/affiliate.routes"));
  app.use("/api/notifications", require("../src/routes/notification.routes"));
  app.use("/api/admin/disbursements", require("../src/routes/admin.disbursement.routes"));
});

after(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.reset();
  sentSms.length = 0;
  const pw = await bcrypt.hash("password123", 10);
  const mk = (phone, role, extra = {}) => User.create({ Fullname: `${role} user`, password: pw, phone, role, ...extra });
  buyer = await mk("+250788200001", "buyer", { email: "buyer@example.com" });
  vendor = await mk("+250788200002", "vendor", { companyName: "A" });
  vendorB = await mk("+250788200003", "vendor", { companyName: "B" });
  admin = await mk("+250788200004", "super_admin");
  courier = await mk("+250788200005", "delivery");
  affiliate = await mk("+250788200006", "affiliate");
  const category = await Category.create({ name: "Electronics", slug: "electronics" });
  const base = { category: category._id, description: "d", media: { mainImage: "/u.jpg" }, status: "ACTIVE", stockQuantity: 10, price: 20000 };
  product = await Product.create({ ...base, name: "Speaker", vendor: vendor._id });
  productB = await Product.create({ ...base, name: "Cable", vendor: vendorB._id });
});

async function paidOrder(items = [{ productId: String(product._id), quantity: 1 }]) {
  const res = await request(app).post("/api/orders/direct-checkout").set(auth(buyer)).send({ ...delivery, items });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const pay = await request(app).post("/api/payments/pay").set(auth(buyer)).send({ orderId: res.body.order.id, phoneNumber: "0788123456" });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  return Order.findById(res.body.order.id);
}

test("password reset by phone code, wrong codes are limited, old sessions are signed out", async () => {
  const oldToken = token(buyer);
  await new Promise((r) => setTimeout(r, 1100)); // token iat is in seconds

  const sent = await request(app).post("/api/auth/forgot-password").send({ phone: "0788200001" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const code = sentSms.at(-1).text.match(/\d{6}/)[0];

  const unknown = await request(app).post("/api/auth/forgot-password").send({ phone: "0788999999" });
  assert.equal(unknown.status, 200, "does not reveal whether an account exists");

  assert.equal((await request(app).post("/api/auth/verify-reset-otp").send({ phone: "0788200001", code: "000000" })).status, 400);
  const ok = await request(app).post("/api/auth/verify-reset-otp").send({ phone: "0788200001", code });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));

  const reset = await request(app).post("/api/auth/reset-password").send({ resetToken: ok.body.resetToken, newPassword: "newpassword1" });
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  const again = await request(app).post("/api/auth/reset-password").send({ resetToken: ok.body.resetToken, newPassword: "another123" });
  assert.equal(again.status, 400, "a reset token works once");

  const login = await request(app).post("/api/auth/login").send({ phone: "0788200001", password: "newpassword1" });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const stale = await request(app).get("/api/auth/me").set({ Authorization: `Bearer ${oldToken}` });
  assert.equal(stale.status, 401, "sessions from before the reset are revoked");
});

test("changing the password keeps this session and returns a fresh token", async () => {
  const res = await request(app).post("/api/auth/change-password").set(auth(buyer)).send({ currentPassword: "password123", newPassword: "brandnew123" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.token);
  assert.equal((await request(app).get("/api/auth/me").set({ Authorization: `Bearer ${res.body.token}` })).status, 200);
});

test("vendors cannot fake payment or delivery; fulfilment only moves forward", async () => {
  const order = await paidOrder();
  const set = (body) => request(app).patch("/api/orders/vendor/status").set(auth(vendor)).send({ orderId: String(order._id), ...body });
  assert.equal((await set({ paymentStatus: "PAID" })).status, 400);
  assert.equal((await set({ status: "DELIVERED" })).status, 400);
  assert.equal((await set({ status: "SHIPPED" })).status, 200);
  assert.equal((await set({ status: "PROCESSING" })).status, 400, "cannot move backward");
  assert.equal((await request(app).patch(`/api/orders/${order._id}/status`).set(auth(vendor)).send({ status: "COMPLETED" })).status, 400);

  const unpaid = await request(app).post("/api/orders/direct-checkout").set(auth(buyer)).send({ ...delivery, items: [{ productId: String(product._id), quantity: 1 }] });
  assert.equal((await set({ orderId: unpaid.body.order.id, status: "SHIPPED" }).then((r) => r)).status, 400);

  const notes = await Notification.find({ recipient: buyer._id }).lean();
  assert.ok(notes.some((n) => /shipped/.test(n.title)), "buyer is told the order shipped");
});

test("a vendor confirms its own delivery with the buyer's code; wrong codes lock after 5", async () => {
  const order = await paidOrder([{ productId: String(product._id), quantity: 1 }, { productId: String(productB._id), quantity: 1 }]);
  const deliver = (user, code) => request(app).patch(`/api/orders/${order._id}/deliver`).set(auth(user)).send({ deliveryOtp: code });

  const first = await deliver(vendor, order.deliveryOtp);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  let fresh = await Order.findById(order._id);
  assert.equal(fresh.orderStatus, "PROCESSING", "multi-vendor order is not complete yet");
  assert.equal(await Settlement.countDocuments({ order: order._id, vendor: vendor._id, status: "RELEASED" }), 1);
  assert.equal(await Settlement.countDocuments({ order: order._id, vendor: vendorB._id, status: "HELD" }), 1);

  for (let i = 0; i < 5; i += 1) assert.equal((await deliver(vendorB, "111111")).status, 400);
  assert.equal((await deliver(vendorB, order.deliveryOtp)).status, 423, "locked after 5 wrong codes");

  const byAdmin = await request(app).patch(`/api/orders/${order._id}/deliver`).set(auth(admin)).send({ deliveryOtp: order.deliveryOtp });
  assert.equal(byAdmin.status, 423, "the lock also applies to admins until support resets it");
  await Order.updateOne({ _id: order._id }, { deliveryOtpAttempts: 0 });
  assert.equal((await deliver(vendorB, order.deliveryOtp)).status, 200);
  fresh = await Order.findById(order._id);
  assert.equal(fresh.orderStatus, "DELIVERED");
  assert.equal(await Settlement.countDocuments({ order: order._id, status: "HELD" }), 0);
});

test("couriers only confirm deliveries assigned to them", async () => {
  const order = await paidOrder();
  const deliver = () => request(app).patch(`/api/orders/${order._id}/deliver`).set(auth(courier)).send({ deliveryOtp: order.deliveryOtp });
  assert.equal((await deliver()).status, 403);
  assert.equal((await request(app).patch(`/api/orders/${order._id}/courier`).set(auth(admin)).send({ courierId: String(buyer._id) })).status, 400);
  assert.equal((await request(app).patch(`/api/orders/${order._id}/courier`).set(auth(admin)).send({ courierId: String(courier._id) })).status, 200);
  const list = await request(app).get("/api/orders/deliverable").set(auth(courier));
  assert.equal(list.body.orders.length, 1);
  assert.equal(list.body.orders[0].deliveryOtp, undefined);
  assert.equal((await deliver()).status, 200);
  assert.ok(sentSms.some((s) => /assigned to you/.test(s.text)), "courier gets an SMS");
});

test("payment sends the buyer the delivery code and tells the vendor", async () => {
  const order = await paidOrder();
  assert.ok(sentSms.some((s) => s.text.includes(order.deliveryOtp) && s.phone === "+250788123456"));
  assert.ok(await Notification.exists({ recipient: vendor._id, title: new RegExp(order.orderNumber) }));
});

test("cancelling a paid order sends the refund automatically", async () => {
  const order = await paidOrder();
  const res = await request(app).post(`/api/orders/${order._id}/cancel`).set(auth(buyer));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.message, /refund was sent/);
  const refund = await Disbursement.findOne({ order: order._id });
  assert.equal(refund.status, "SUCCESS");
  assert.equal(refund.amount, order.totalAmount);
  assert.equal(refund.phone, "250788123456");
  assert.ok(await Notification.exists({ recipient: buyer._id, title: /Refund sent/ }));
  // Cancelling twice can never refund twice.
  assert.equal((await request(app).post(`/api/orders/${order._id}/cancel`).set(auth(buyer))).status, 400);
  assert.equal(await Disbursement.countDocuments({ order: order._id }), 1);
});

test("dispute refund reverses escrow and pays the buyer; vendor release cannot be paid twice", async () => {
  const order = await paidOrder();
  const open = await request(app).post("/api/disputes").set(auth(buyer)).send({ orderId: String(order._id), reason: "DAMAGED_GOODS", description: "Arrived broken in the box." });
  assert.equal(open.status, 201, JSON.stringify(open.body));
  const dispute = await Dispute.findOne({ order: order._id });
  const res = await request(app).post(`/api/disputes/${dispute._id}/arbitrate`).set(auth(admin)).send({ decision: "REFUND_BUYER" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await Settlement.countDocuments({ order: order._id, status: "REFUNDED" }), 1);
  assert.equal((await Disbursement.findOne({ order: order._id })).status, "SUCCESS");

  const order2 = await paidOrder();
  await request(app).post("/api/disputes").set(auth(buyer)).send({ orderId: String(order2._id), reason: "OTHER", description: "Seller says it was delivered." });
  const d2 = await Dispute.findOne({ order: order2._id });
  assert.equal((await request(app).post(`/api/disputes/${d2._id}/arbitrate`).set(auth(admin)).send({ decision: "RELEASE_TO_VENDOR" })).status, 200);
  assert.equal(await Settlement.countDocuments({ order: order2._id, status: "RELEASED" }), 1);
  const deliver = await request(app).patch(`/api/orders/${order2._id}/deliver`).set(auth(vendor)).send({ deliveryOtp: (await Order.findById(order2._id)).deliveryOtp });
  assert.equal(deliver.status, 200);
  assert.equal(await Settlement.countDocuments({ order: order2._id, status: "RELEASED" }), 1, "no second release");
});

test("unpaid orders get one payment reminder", async () => {
  const res = await request(app).post("/api/orders/direct-checkout").set(auth(buyer)).send({ ...delivery, items: [{ productId: String(product._id), quantity: 1 }] });
  await Order.updateOne({ _id: res.body.order.id }, { $set: { createdAt: new Date(Date.now() - 22 * 60 * 1000) } });
  await sendPaymentReminders();
  await sendPaymentReminders();
  assert.equal(await Notification.countDocuments({ recipient: buyer._id, type: "PAYMENT" }), 1);
});

test("wishlist is saved to the account", async () => {
  const add = await request(app).post("/api/auth/wishlist").set(auth(buyer)).send({ productIds: [String(product._id), String(product._id), "bad"] });
  assert.equal(add.status, 200);
  assert.equal(add.body.items.length, 1);
  assert.equal(add.body.items[0].savedPrice, 20000);
  const del = await request(app).delete(`/api/auth/wishlist/${product._id}`).set(auth(buyer));
  assert.equal(del.body.items.length, 0);
});

test("affiliate withdrawals: small ones are sent automatically, large ones after one-click approval", async () => {
  await AffiliateWallet.create({ affiliateUser: affiliate._id, availableBalance: 500000, pendingBalance: 0 });
  const ask = (amount, phone = "0788200006", method = "MTN_MOMO") =>
    request(app).post("/api/affiliates/payouts/request").set(auth(affiliate)).send({ amount, paymentMethod: method, accountDetails: { phoneNumber: phone } });

  assert.equal((await ask(20000, "0731234567")).status, 400, "Airtel number on MTN method is refused");
  const small = await ask(20000);
  assert.equal(small.status, 201, JSON.stringify(small.body));
  assert.equal((await AffiliatePayout.findOne({ amount: 20000 })).status, "COMPLETED");

  await ask(200000);
  const big = await AffiliatePayout.findOne({ amount: 200000 });
  assert.equal(big.status, "PENDING");
  const approve = await request(app).post(`/api/affiliates/payouts/${big._id}/process`).set(auth(admin)).send({ status: "APPROVED" });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  assert.equal((await AffiliatePayout.findById(big._id)).status, "COMPLETED");
  const wallet = await AffiliateWallet.findOne({ affiliateUser: affiliate._id });
  assert.equal(wallet.availableBalance, 280000);
  assert.equal(wallet.totalWithdrawn, 220000);
  assert.ok(await Notification.exists({ recipient: affiliate._id, title: "Withdrawal sent" }));
});

test("only admins can send manual notifications", async () => {
  const res = await request(app).post("/api/notifications").set(auth(buyer)).send({ recipient: String(vendor._id), title: "Fake" });
  assert.equal(res.status, 403);
});
