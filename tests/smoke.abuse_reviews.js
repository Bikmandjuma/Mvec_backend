process.env.JWT_SECRET = "smoke_secret";
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");

const cleanString = (s) => String(s || "").trim();

async function main() {
  const mongo = await MongoMemoryServer.create({ binary: { version: "7.0.0" }, instance: { launchTimeout: 60000 } });
  await mongoose.connect(mongo.getUri());

  const User = require("../src/models/User");
  const Product = require("../src/models/Product");
  const Category = require("../src/models/Category");
  const Order = require("../src/models/Order");
  const Review = require("../src/models/Review");
  const AbuseReport = require("../src/models/AbuseReport");

  const app = express();
  app.use(express.json());
  app.use("/api/reviews", require("../src/routes/review.routes"));
  app.use("/api/users", require("../src/routes/user.routes"));
  app.use("/api/abuse-reports", require("../src/routes/abuseReport.routes"));

  const JWT_SECRET = "smoke_secret";
  const buyer = await User.create({ Fullname: "Alice Buyer", email: "alice@smoke.rw", password: "x", phone: "0788123456", gender: "female", role: "buyer" });
  const vendor = await User.create({ Fullname: "Vendor Co", email: "vendor@smoke.rw", password: "x", phone: "0788000001", gender: "male", role: "vendor", companyName: "Vendor Co Ltd" });
  const vendorToken = jwt.sign({ id: vendor._id, role: vendor.role }, JWT_SECRET);

  const cat = await Category.create({ name: "Electronics", slug: "electronics" });
  const product = await Product.create({ vendor: vendor._id, category: cat._id, brand: "B", name: "Smoke Headphones", slug: "smoke-headphones", sku: "SMK-HP-1", description: "d", price: 5000, stockQuantity: 10, status: "ACTIVE", media: { mainImage: "http://x.y/img.jpg" } });
  const order = await Order.create({ user: buyer._id, orderNumber: "ORD-SMOKE-1", items: [{ product: product._id, vendor: vendor._id, category: cat._id, name: "Smoke Headphones", price: 5000, quantity: 1 }], shippingAddress: { street: "KN 5", city: "Kigali", state: "Kigali", country: "Rwanda" }, totalAmount: 5000, paymentStatus: "PAID", orderStatus: "DELIVERED" });
  const review = await Review.create({ user: buyer._id, product: product._id, parentOrder: order._id, rating: 4, reviewText: "Pretty good", isVerifiedPurchase: true });

  const assert = require("assert");

  // 1. GET /api/reviews/vendor (alias)
  let res = await request(app).get("/api/reviews/vendor").set("Authorization", `Bearer ${vendorToken}`);
  assert.strictEqual(res.status, 200, "vendor reviews list");
  assert.ok(res.body.data.length >= 1);
  assert.strictEqual(res.body.data[0].orderId, String(order._id));
  assert.strictEqual(res.body.data[0].product, "Smoke Headphones");
  console.log("1. GET /reviews/vendor OK:", cleanString(res.body.data[0].reviewer));

  // 2. POST /api/reviews/:id/reply
  res = await request(app).post(`/api/reviews/${review._id}/reply`).set("Authorization", `Bearer ${vendorToken}`).send({ reply: "Thanks for your feedback!" });
  assert.strictEqual(res.status, 200, "reply to review");
  assert.strictEqual(res.body.review.vendorReply, "Thanks for your feedback!");
  console.log("2. POST /reviews/:id/reply OK");

  // 3. GET /api/users/search?q=Alice
  res = await request(app).get("/api/users/search").query({ q: "Alice" }).set("Authorization", `Bearer ${vendorToken}`);
  assert.strictEqual(res.status, 200, "user search");
  assert.ok(res.body.data.some((d) => d.kind === "user" && d.label === "Alice Buyer"));
  console.log("3. GET /users/search OK:", res.body.data.map((d) => `${d.kind}:${d.label}`).join(" | "));

  // 4. POST /api/abuse-reports
  res = await request(app).post("/api/abuse-reports").set("Authorization", `Bearer ${vendorToken}`).send({
    targetUserId: String(buyer._id),
    reasonCategory: "FRAUDULENT_ACTIVITY",
    description: "Customer opened a bogus dispute after receiving goods.",
    evidenceUrls: ["https://evidence.example.com/1.png"],
    relatedOrderId: String(order._id),
  });
  assert.strictEqual(res.status, 201, "submit abuse report");
  assert.strictEqual(res.body.report.targetUserId, String(buyer._id));
  assert.ok(res.body.report.reportNumber.startsWith("ABR-"));
  const reportId = res.body.report.id;
  console.log("4. POST /abuse-reports OK:", res.body.report.reportNumber);

  // 5. GET /api/abuse-reports
  res = await request(app).get("/api/abuse-reports").set("Authorization", `Bearer ${vendorToken}`);
  assert.strictEqual(res.status, 200);
  assert.ok(res.body.data.length >= 1);
  assert.strictEqual(res.body.data[0].targetUser, "Alice Buyer");
  console.log("5. GET /abuse-reports OK:", res.body.data[0].status);

  // 6. GET /api/abuse-reports/:id
  res = await request(app).get(`/api/abuse-reports/${reportId}`).set("Authorization", `Bearer ${vendorToken}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.report.order.orderNumber, "ORD-SMOKE-1");
  console.log("6. GET /abuse-reports/:id OK");

  // 7. Validation: missing reasonCategory rejected
  res = await request(app).post("/api/abuse-reports").set("Authorization", `Bearer ${vendorToken}`).send({ targetUserId: String(buyer._id), description: "x" });
  assert.strictEqual(res.status, 400);
  console.log("7. Validation (reason required) OK");

  console.log("\nALL SMOKE TESTS PASSED");
  await mongoose.disconnect();
  await mongo.stop();
  process.exit(0);
}

main().catch((err) => { console.error("FAIL", err); process.exit(1); });