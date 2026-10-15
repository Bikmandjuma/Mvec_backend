// Card payments (Flutterwave): checkout link, verification before an order is
// marked paid, webhook signature, and refunds that go back to the card.
const db = require("./helpers/mysql"); // first: selects the MySQL test database
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "card_payment_test_secret";
process.env.FLW_SECRET_KEY = "FLWSECK_TEST-x";
process.env.FLW_WEBHOOK_HASH = "card-hook-hash";

const User = require("../src/models/User");
const Product = require("../src/models/Product");
const Category = require("../src/models/Category");
const Order = require("../src/models/Order");
const Payment = require("../src/models/Payment");
const Settlement = require("../src/models/Settlement");
const Disbursement = require("../src/models/Disbursement");
const flutterwave = require("../src/services/flutterwave.service");

let app, buyer, vendor, product;
const auth = (u) => ({ Authorization: `Bearer ${jwt.sign({ userId: String(u._id) }, process.env.JWT_SECRET)}` });
const delivery = {
  shippingAddress: { street: "KG 11 Ave", district: "Gasabo", province: "Kigali City" },
  recipient: { name: "Card Buyer", phone: "0788123456" },
};

// Flutterwave stand-in: records calls, answers like the real API.
const gateway = { checkouts: [], verify: new Map(), refunds: [] };
const originals = {};
before(async () => {
  await db.setup();
  Object.assign(originals, flutterwave);
  flutterwave.createCheckout = async (args) => { gateway.checkouts.push(args); return { link: `https://checkout.flutterwave.test/${args.txRef}` }; };
  flutterwave.verifyByReference = async (txRef) => gateway.verify.get(txRef) || { status: "PENDING" };
  flutterwave.refund = async (args) => { gateway.refunds.push(args); return { status: "SUCCESSFUL", reference: "RF-1" }; };
  app = express();
  app.use(express.json());
  app.use("/api/orders", require("../src/routes/order.routes"));
  app.use("/api/payments", require("../src/routes/payment.routes"));
  app.use("/api/webhooks", require("../src/routes/webhook.routes"));
});
after(async () => { Object.assign(flutterwave, originals); await db.close(); });

beforeEach(async () => {
  await db.reset();
  gateway.checkouts.length = 0; gateway.verify.clear(); gateway.refunds.length = 0;
  vendor = await User.create({ Fullname: "Seller", password: "x", phone: "0788000201", role: "vendor", companyName: "Seller Co" });
  buyer = await User.create({ Fullname: "Card Buyer", password: "x", phone: "0788000202", role: "buyer", email: "card@example.rw" });
  const category = await Category.create({ name: "Phones", slug: "phones" });
  product = await Product.create({ name: "Phone", price: 50000, stockQuantity: 5, status: "ACTIVE", vendor: vendor._id, category: category._id, description: "d", media: { mainImage: "/p.jpg" } });
});

async function placeOrder() {
  const res = await request(app).post("/api/orders/direct-checkout").set(auth(buyer)).send({ ...delivery, items: [{ productId: String(product._id), quantity: 1 }] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.order;
}

test("card checkout opens Flutterwave and only verified payments mark the order paid", async () => {
  const order = await placeOrder();
  const start = await request(app).post("/api/payments/pay/card").set(auth(buyer)).send({ orderId: order.id });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.match(start.body.checkoutUrl, /checkout\.flutterwave\.test/);
  const checkout = gateway.checkouts[0];
  assert.equal(checkout.amount, order.totalAmount);
  assert.match(checkout.redirectUrl, new RegExp(`/payment/${order.id}\\?paymentId=`));

  // Still pending at Flutterwave: nothing changes.
  let status = await request(app).get(`/api/payments/status/${start.body.paymentId}`).set(auth(buyer));
  assert.equal(status.body.order.paymentStatus, "PENDING");

  // Paid with the wrong amount: refused, order stays unpaid.
  gateway.verify.set(checkout.txRef, { status: "SUCCESSFUL", amount: 1, currency: "RWF", id: "F-1", fee: 0, raw: {} });
  status = await request(app).get(`/api/payments/status/${start.body.paymentId}`).set(auth(buyer));
  assert.equal((await Order.findById(order.id)).paymentStatus, "PENDING");

  // Paid in full: order paid by card, money held in escrow.
  gateway.verify.set(checkout.txRef, { status: "SUCCESSFUL", amount: order.totalAmount, currency: "RWF", id: "F-2", fee: 700, raw: {} });
  status = await request(app).get(`/api/payments/status/${start.body.paymentId}`).set(auth(buyer));
  assert.equal(status.status, 200, JSON.stringify(status.body));
  const paid = await Order.findById(order.id);
  assert.equal(paid.paymentStatus, "PAID");
  assert.equal(paid.paymentMethod, "CARD");
  assert.equal((await Payment.findById(start.body.paymentId)).gatewayReference, "F-2");
  assert.ok(await Settlement.exists({ order: order.id, status: "HELD" }));
});

test("webhooks need the secret hash and are re-verified with Flutterwave", async () => {
  const order = await placeOrder();
  const start = await request(app).post("/api/payments/pay/card").set(auth(buyer)).send({ orderId: order.id });
  const txRef = gateway.checkouts[0].txRef;
  const body = { event: "charge.completed", data: { tx_ref: txRef, status: "successful", amount: order.totalAmount } };

  assert.equal((await request(app).post("/api/webhooks/flutterwave").send(body)).status, 401);
  // A forged "successful" webhook is not enough: Flutterwave still says pending.
  await request(app).post("/api/webhooks/flutterwave").set("verif-hash", "card-hook-hash").send(body);
  assert.equal((await Order.findById(order.id)).paymentStatus, "PENDING");

  gateway.verify.set(txRef, { status: "SUCCESSFUL", amount: order.totalAmount, currency: "RWF", id: "F-9", fee: 0, raw: {} });
  const ok = await request(app).post("/api/webhooks/flutterwave").set("verif-hash", "card-hook-hash").send(body);
  assert.equal(ok.status, 200);
  assert.equal((await Order.findById(order.id)).paymentStatus, "PAID");
  const again = await request(app).post("/api/webhooks/flutterwave").set("verif-hash", "card-hook-hash").send(body);
  assert.equal(again.body.message, "Already processed.");
  assert.equal(String((await Payment.findById(start.body.paymentId)).status), "SUCCESS");
});

test("cancelling a card-paid order refunds the card, not a phone", async () => {
  const order = await placeOrder();
  const start = await request(app).post("/api/payments/pay/card").set(auth(buyer)).send({ orderId: order.id });
  gateway.verify.set(gateway.checkouts[0].txRef, { status: "SUCCESSFUL", amount: order.totalAmount, currency: "RWF", id: "F-7", fee: 0, raw: {} });
  await request(app).get(`/api/payments/status/${start.body.paymentId}`).set(auth(buyer));

  const cancel = await request(app).post(`/api/orders/${order.id}/cancel`).set(auth(buyer)).send({});
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
  assert.match(cancel.body.message, /card/);
  assert.deepEqual(gateway.refunds, [{ transactionId: "F-7", amount: order.totalAmount }]);
  const d = await Disbursement.findOne({ order: order.id });
  assert.equal(d.channel, "CARD");
  assert.equal(d.status, "SUCCESS");
});

test("someone else's order cannot be paid by card", async () => {
  const order = await placeOrder();
  const other = await User.create({ Fullname: "Other", password: "x", phone: "0788000203", role: "buyer" });
  const res = await request(app).post("/api/payments/pay/card").set(auth(other)).send({ orderId: order.id });
  assert.equal(res.status, 404);
});
