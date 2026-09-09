const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");

const User = require("../../src/models/User");
const Product = require("../../src/models/Product");
const Category = require("../../src/models/Category");
const Order = require("../../src/models/Order");
const Store = require("../../src/models/Store");
const Review = require("../../src/models/Review");
const Promotion = require("../../src/models/Promotion");
const ShippingZone = require("../../src/models/ShippingZone");
const Notification = require("../../src/models/Notification");

jest.setTimeout(60000);

let mongoServer;
let app;
const JWT_SECRET = "test_operations_secret_key";

function createTestApp() {
  const testApp = express();
  testApp.use(helmet());
  testApp.use(cors());
  testApp.use(express.json());

  testApp.use("/api/reviews", require("../../src/routes/review.routes"));
  testApp.use("/api/users", require("../../src/routes/user.routes"));
  testApp.use("/api/promotions", require("../../src/routes/promotion.routes"));
  testApp.use("/api/shipping", require("../../src/routes/shipping.routes"));
  testApp.use("/api/notifications", require("../../src/routes/notification.routes"));
  testApp.use("/api/reports", require("../../src/routes/report.routes"));

  return testApp;
}

describe("Operations: Reviews, Users, Promotions, Shipping, Notifications, Reports", () => {
  let superAdmin, vendorUser, buyerUser;
  let superAdminToken, vendorToken, buyerToken;
  let store, product, category;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = JWT_SECRET;
    mongoServer = await MongoMemoryServer.create({
      binary: { version: "7.0.0" },
      replSet: { count: 1 },
    });
    await mongoose.connect(mongoServer.getUri());
    app = createTestApp();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      User.deleteMany({}),
      Product.deleteMany({}),
      Category.deleteMany({}),
      Order.deleteMany({}),
      Store.deleteMany({}),
      Review.deleteMany({}),
      Promotion.deleteMany({}),
      ShippingZone.deleteMany({}),
      Notification.deleteMany({}),
    ]);

    superAdmin = await User.create({
      Fullname: "Super Admin",
      email: "admin@mvec.rw",
      password: "password123",
      phone: "0788000001",
      gender: "male",
      role: "super_admin",
    });
    vendorUser = await User.create({
      Fullname: "Kigali Tech Store",
      email: "vendor@kigali.rw",
      password: "password123",
      phone: "0788000002",
      gender: "female",
      role: "vendor",
      companyName: "Kigali Electronics Ltd",
    });
    buyerUser = await User.create({
      Fullname: "Jean Paul",
      email: "jeanpaul@gmail.com",
      password: "password123",
      phone: "0788123456",
      gender: "male",
      role: "buyer",
    });

    superAdminToken = jwt.sign({ userId: superAdmin._id, role: superAdmin.role }, JWT_SECRET);
    vendorToken = jwt.sign({ userId: vendorUser._id, role: vendorUser.role }, JWT_SECRET);
    buyerToken = jwt.sign({ userId: buyerUser._id, role: buyerUser.role }, JWT_SECRET);

    category = await Category.create({ name: "Electronics", slug: "electronics" });
    store = await Store.create({
      vendor: vendorUser._id,
      storeName: "Kigali Tech Store",
      slug: "kigali-tech-store",
      contactEmail: "vendor@kigali.rw",
      contactPhone: "0788000002",
      status: "ACTIVE",
    });
    product = await Product.create({
      vendor: vendorUser._id,
      category: category._id,
      name: "Wireless Headphones",
      price: 68000,
      stockQuantity: 20,
      description: "Great noise cancelling headphones",
      media: { mainImage: "https://img.example/h.png" },
      status: "ACTIVE",
    });
  });

  async function makeDeliveredOrder() {
    return Order.create({
      user: buyerUser._id,
      orderNumber: `ORD-${Date.now()}`,
      items: [{ product: product._id, vendor: vendorUser._id, name: "Wireless Headphones", price: 68000, quantity: 1 }],
      shippingAddress: { street: "KN 5", city: "Kigali", state: "Kigali", country: "Rwanda" },
      totalAmount: 68000,
      paymentStatus: "PAID",
      orderStatus: "DELIVERED",
    });
  }

  describe("1. Reviews", () => {
    test("Buyer can create a review after a delivered purchase", async () => {
      await makeDeliveredOrder();
      const res = await request(app)
        .post("/api/reviews")
        .set("Authorization", `Bearer ${buyerToken}`)
        .send({ product: product._id, rating: 5, reviewText: "Excellent!" });

      expect(res.status).toBe(201);
      expect(res.body.review.rating).toBe(5);
      expect(res.body.review.product).toBe("Wireless Headphones");
      expect(res.body.review.reviewer).toBe("Jean Paul");
    });

    test("Buyer cannot review a product they have not purchased", async () => {
      const res = await request(app)
        .post("/api/reviews")
        .set("Authorization", `Bearer ${buyerToken}`)
        .send({ product: product._id, rating: 5 });

      expect(res.status).toBe(403);
    });

    test("Vendor can list reviews on their own products", async () => {
      await makeDeliveredOrder();
      await Review.create({
        user: buyerUser._id,
        product: product._id,
        parentOrder: (await makeDeliveredOrder())._id,
        rating: 4,
        reviewText: "Good value",
        status: "PUBLISHED",
      });

      const res = await request(app)
        .get("/api/reviews/vendor/mine")
        .set("Authorization", `Bearer ${vendorToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].product).toBe("Wireless Headphones");
    });

    test("Admin can list and moderate reviews", async () => {
      await Review.create({
        user: buyerUser._id,
        product: product._id,
        parentOrder: (await makeDeliveredOrder())._id,
        rating: 3,
        reviewText: "Okay",
        status: "PENDING",
      });

      const listed = await request(app)
        .get("/api/reviews")
        .set("Authorization", `Bearer ${superAdminToken}`);
      expect(listed.status).toBe(200);
      expect(listed.body.meta.total).toBe(1);
      expect(listed.body.data[0].status).toBe("PENDING");

      const id = listed.body.data[0].id;
      const updated = await request(app)
        .patch(`/api/reviews/${id}`)
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send({ status: "PUBLISHED" });
      expect(updated.status).toBe(200);
      expect(updated.body.review.status).toBe("PUBLISHED");
    });

    test("Guests can list published reviews for a product", async () => {
      await Review.create({
        user: buyerUser._id,
        product: product._id,
        parentOrder: (await makeDeliveredOrder())._id,
        rating: 5,
        reviewText: "Great",
        status: "PUBLISHED",
      });
      const res = await request(app).get(`/api/reviews/product/${product._id}`);
      expect(res.status).toBe(200);
      expect(res.body.count).toBe(1);
      expect(res.body.averageRating).toBe("5.0");
    });
  });

  describe("2. Users / Customers", () => {
    test("Admin lists all users", async () => {
      const res = await request(app)
        .get("/api/users")
        .set("Authorization", `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(3);
      expect(res.body.data.map((u) => u.role).sort()).toEqual(
        ["buyer", "super_admin", "vendor"].sort()
      );
    });

    test("Admin can filter users by role and search", async () => {
      const res = await request(app)
        .get("/api/users?role=vendor")
        .set("Authorization", `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0].name).toBe("Kigali Tech Store");
    });

    test("Admin can update a user role", async () => {
      const res = await request(app)
        .patch(`/api/users/${buyerUser._id}`)
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send({ status: "SUSPENDED" });
      expect(res.status).toBe(200);
      expect(res.body.user.status).toBe("SUSPENDED");
    });

    test("Vendor lists customers who ordered their products", async () => {
      await makeDeliveredOrder();
      const res = await request(app)
        .get("/api/users/vendor/customers")
        .set("Authorization", `Bearer ${vendorToken}`);
      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0].name).toBe("Jean Paul");
      expect(res.body.data[0].orders).toBe(1);
    });

    test("Non-admin cannot list all users", async () => {
      const res = await request(app)
        .get("/api/users")
        .set("Authorization", `Bearer ${buyerToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe("3. Promotions", () => {
    test("Vendor creates a promotion", async () => {
      const res = await request(app)
        .post("/api/promotions")
        .set("Authorization", `Bearer ${vendorToken}`)
        .send({ name: "Back to School", code: "SCHOOL15", type: "PERCENT", value: 15, status: "ACTIVE" });

      expect(res.status).toBe(201);
      expect(res.body.promotion.code).toBe("SCHOOL15");
      expect(res.body.promotion.discount).toBe("15%");
    });

    test("Promotion code must be unique", async () => {
      await Promotion.create({
        name: "First", code: "DUP15", type: "PERCENT", value: 15, createdBy: vendorUser._id,
      });
      const res = await request(app)
        .post("/api/promotions")
        .set("Authorization", `Bearer ${vendorToken}`)
        .send({ name: "Second", code: "dup15", type: "PERCENT", value: 20 });
      expect(res.status).toBe(409);
    });

    test("Vendor lists only own promotions", async () => {
      await Promotion.create({ name: "Mine", code: "MY10", type: "PERCENT", value: 10, vendor: vendorUser._id, createdBy: vendorUser._id });
      const other = await User.create({ Fullname: "Other", email: "other@x.rw", password: "x", phone: "0788999999", gender: "male", role: "vendor", companyName: "Other Ltd" });
      await Promotion.create({ name: "Theirs", code: "TH5", type: "PERCENT", value: 5, vendor: other._id, createdBy: other._id });

      const res = await request(app)
        .get("/api/promotions")
        .set("Authorization", `Bearer ${vendorToken}`);
      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0].name).toBe("Mine");
    });

    test("Vendor updates and deletes own promotion", async () => {
      const promo = await Promotion.create({ name: "Sale", code: "SALE5", type: "PERCENT", value: 5, vendor: vendorUser._id, createdBy: vendorUser._id, status: "DRAFT" });
      const patched = await request(app)
        .patch(`/api/promotions/${promo._id}`)
        .set("Authorization", `Bearer ${vendorToken}`)
        .send({ status: "ACTIVE" });
      expect(patched.status).toBe(200);
      expect(patched.body.promotion.status).toBe("ACTIVE");

      const deleted = await request(app)
        .delete(`/api/promotions/${promo._id}`)
        .set("Authorization", `Bearer ${vendorToken}`);
      expect(deleted.status).toBe(200);
      expect(await Promotion.findById(promo._id)).toBeNull();
    });
  });

  describe("4. Shipping zones", () => {
    test("Vendor creates a shipping zone", async () => {
      const res = await request(app)
        .post("/api/shipping/zones")
        .set("Authorization", `Bearer ${vendorToken}`)
        .send({ name: "Kigali City", fee: 2000, eta: "Same day", methods: ["STANDARD", "PICKUP"] });

      expect(res.status).toBe(201);
      expect(res.body.zone.name).toBe("Kigali City");
      expect(res.body.zone.method).toBe("STANDARD / PICKUP");
    });

    test("Vendor cannot create zone without a store", async () => {
      const bare = await User.create({ Fullname: "No Store", email: "nostore@x.rw", password: "x", phone: "0788111111", gender: "male", role: "vendor", companyName: "No Store Ltd" });
      const token = jwt.sign({ userId: bare._id, role: "vendor" }, JWT_SECRET);
      const res = await request(app)
        .post("/api/shipping/zones")
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Zone", fee: 1000 });
      expect(res.status).toBe(400);
    });

    test("Lists active zones publicly", async () => {
      await ShippingZone.create({ name: "Kigali", fee: 2000, status: "ACTIVE" });
      await ShippingZone.create({ name: "North", fee: 5000, status: "PAUSED" });
      const res = await request(app).get("/api/shipping/zones");
      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0].name).toBe("Kigali");
    });
  });

  describe("5. Notifications", () => {
    test("Create and list own notifications", async () => {
      const created = await request(app)
        .post("/api/notifications")
        .set("Authorization", `Bearer ${vendorToken}`)
        .send({ recipient: vendorUser._id, type: "ORDER", title: "New order received", message: "Order ORD-1004", reference: "ORD-1004" });
      expect(created.status).toBe(201);

      const res = await request(app)
        .get("/api/notifications/mine")
        .set("Authorization", `Bearer ${vendorToken}`);
      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(1);
      expect(res.body.data[0].status).toBe("Unread");
    });

    test("Mark a notification as read", async () => {
      const n = await Notification.create({ recipient: vendorUser._id, type: "SYSTEM", title: "Hello", message: "x" });
      const res = await request(app)
        .patch(`/api/notifications/${n._id}/read`)
        .set("Authorization", `Bearer ${vendorToken}`);
      expect(res.status).toBe(200);
      expect(res.body.notification.status).toBe("Read");
    });

    test("Mark all notifications read", async () => {
      await Notification.create({ recipient: vendorUser._id, type: "SYSTEM", title: "a", message: "x" });
      await Notification.create({ recipient: vendorUser._id, type: "SYSTEM", title: "b", message: "x" });
      await request(app)
        .post("/api/notifications/read-all")
        .set("Authorization", `Bearer ${vendorToken}`)
        .expect(200);
      expect(await Notification.countDocuments({ recipient: vendorUser._id, isRead: false })).toBe(0);
    });

    test("Users cannot mark others' notifications as read", async () => {
      const n = await Notification.create({ recipient: vendorUser._id, type: "SYSTEM", title: "private", message: "x" });
      const res = await request(app)
        .patch(`/api/notifications/${n._id}/read`)
        .set("Authorization", `Bearer ${buyerToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe("6. Reports", () => {
    test("Admin summary returns platform metrics", async () => {
      await makeDeliveredOrder();
      const res = await request(app)
        .get("/api/reports/summary?range=30d")
        .set("Authorization", `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(res.body.metrics.orders).toBeGreaterThanOrEqual(1);
      expect(res.body.metrics.grossSales).toBeGreaterThanOrEqual(68000);
    });

    test("Vendor summary scopes orders to own products", async () => {
      await makeDeliveredOrder();
      const res = await request(app)
        .get("/api/reports/summary?range=30d")
        .set("Authorization", `Bearer ${vendorToken}`);
      expect(res.status).toBe(200);
      expect(res.body.metrics.orders).toBeGreaterThanOrEqual(1);
    });

    test("Revenue series returns labels and values", async () => {
      await makeDeliveredOrder();
      const res = await request(app)
        .get("/api/reports/revenue")
        .set("Authorization", `Bearer ${superAdminToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.labels)).toBe(true);
      expect(Array.isArray(res.body.series)).toBe(true);
    });
  });
});
