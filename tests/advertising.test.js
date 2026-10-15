// The home page hero and featured strip only show admin-approved, live ad
// campaigns for the vendor's own products. New products never land there.
const db = require("./helpers/mysql"); // first: selects the MySQL test database
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const request = require("supertest");
const jwt = require("jsonwebtoken");

process.env.JWT_SECRET = "advertising_test_secret";

const User = require("../src/models/User");
const Vendor = require("../src/models/Vendor");
const Product = require("../src/models/Product");
const Category = require("../src/models/Category");

let app;
let vendorToken, otherVendorToken, adminToken;
let ownProduct, otherProduct, newProduct;

const auth = (t) => ({ Authorization: `Bearer ${t}` });
const tokenFor = (u) => jwt.sign({ id: u._id.toString() }, process.env.JWT_SECRET);

before(async () => {
  await db.setup();
  app = express();
  app.use(express.json());
  app.use("/api/vendor", require("../src/routes/vendor.service.routes"));
  app.use("/api/admin", require("../src/routes/admin.monetization.routes"));
  app.use("/api/advertisements", require("../src/routes/advertisement.routes"));
});

after(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.reset();
  const make = (phone, role, extra = {}) => User.create({ Fullname: `${role} ${phone}`, password: "x", phone, role, ...extra });
  const vendorUser = await make("+250788100001", "vendor", { companyName: "A Store" });
  const otherUser = await make("+250788100002", "vendor", { companyName: "B Store" });
  const admin = await make("+250788100003", "super_admin");
  [vendorToken, otherVendorToken, adminToken] = [vendorUser, otherUser, admin].map(tokenFor);
  await Vendor.create({ user: vendorUser._id, businessName: "A Store", phone: "0788100001", email: "a@x.rw", status: "ACTIVE", verificationStatus: "VERIFIED" });
  await Vendor.create({ user: otherUser._id, businessName: "B Store", phone: "0788100002", email: "b@x.rw", status: "ACTIVE", verificationStatus: "VERIFIED" });
  const category = await Category.create({ name: "Electronics", slug: "electronics" });
  const base = { category: category._id, description: "d", media: { mainImage: "/uploads/x.jpg" }, status: "ACTIVE", stockQuantity: 5, price: 1000 };
  ownProduct = await Product.create({ ...base, name: "Own product", vendor: vendorUser._id });
  otherProduct = await Product.create({ ...base, name: "Other product", vendor: otherUser._id });
  newProduct = await Product.create({ ...base, name: "Brand new product", vendor: vendorUser._id });
});

const submit = (token, productId, placement = "HOMEPAGE_HERO") =>
  request(app).post("/api/vendor/advertisements").set(auth(token)).send({ product: "x", productId: String(productId), placement, budget: 50000 });

test("a vendor can only advertise its own products", async () => {
  assert.equal((await submit(vendorToken, otherProduct._id)).status, 400);
  assert.equal((await submit(vendorToken, ownProduct._id)).status, 201);
});

test("pending campaigns need admin approval before showing in the hero", async () => {
  const created = await submit(vendorToken, ownProduct._id);
  const adId = created.body.advertisement._id;

  const selfApprove = await request(app).patch(`/api/vendor/advertisements/${adId}/status`).set(auth(vendorToken)).send({ status: "ACTIVE" });
  assert.equal(selfApprove.status, 403);
  let hero = await request(app).get("/api/advertisements?placement=HOMEPAGE_HERO");
  assert.equal(hero.body.data.length, 0);

  const approve = await request(app).patch(`/api/admin/advertisements/${adId}/status`).set(auth(adminToken)).send({ status: "ACTIVE" });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  hero = await request(app).get("/api/advertisements?placement=HOMEPAGE_HERO");
  assert.deepEqual(hero.body.data.map((a) => a.product.name), ["Own product"]);
  assert.ok(!hero.body.data.some((a) => a.product.name === newProduct.name), "new products are not advertised");

  // Approved campaigns can be paused/resumed by the vendor, not by another vendor.
  assert.equal((await request(app).patch(`/api/vendor/advertisements/${adId}/status`).set(auth(otherVendorToken)).send({ status: "PAUSED" })).status, 404);
  assert.equal((await request(app).patch(`/api/vendor/advertisements/${adId}/status`).set(auth(vendorToken)).send({ status: "PAUSED" })).status, 200);
  hero = await request(app).get("/api/advertisements?placement=HOMEPAGE_HERO");
  assert.equal(hero.body.data.length, 0);
});

test("placements are separate and hidden products drop out", async () => {
  const created = await submit(vendorToken, ownProduct._id, "FEATURED");
  await request(app).patch(`/api/admin/advertisements/${created.body.advertisement._id}/status`).set(auth(adminToken)).send({ status: "ACTIVE" });
  assert.equal((await request(app).get("/api/advertisements?placement=HOMEPAGE_HERO")).body.data.length, 0);
  assert.equal((await request(app).get("/api/advertisements?placement=FEATURED")).body.data.length, 1);
  await Product.updateOne({ _id: ownProduct._id }, { status: "INACTIVE" });
  assert.equal((await request(app).get("/api/advertisements?placement=FEATURED")).body.data.length, 0);
  assert.equal((await request(app).get("/api/advertisements?placement=NOPE")).status, 400);
});
