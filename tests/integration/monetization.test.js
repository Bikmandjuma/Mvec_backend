const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");

const User = require("../../src/models/User");
const Vendor = require("../../src/models/Vendor");
const Subscription = require("../../src/models/Subscription");
const BuyerSubscription = require("../../src/models/BuyerSubscription");
const Advertisement = require("../../src/models/Advertisement");
const Translation = require("../../src/models/Translation");

jest.setTimeout(60000);

let mongoServer;
let app;
const JWT_SECRET = "test_monetization_secret_key";

function createTestApp() {
  const testApp = express();
  testApp.use(helmet());
  testApp.use(cors());
  testApp.use(express.json());

  testApp.use("/api/vendor", require("../../src/routes/vendor.service.routes"));
  testApp.use("/api/buyer", require("../../src/routes/buyer.service.routes"));
  testApp.use("/api/admin", require("../../src/routes/admin.monetization.routes"));
  testApp.use("/api/languages", require("../../src/routes/language.routes"));
  testApp.use("/api/admin", require("../../src/routes/adminTranslation.routes"));

  return testApp;
}

describe("Monetization: Subscriptions, Advertisements & Localization", () => {
  let superAdminUser, vendorUser, buyerUser;
  let superAdminToken, vendorToken, buyerToken;
  let vendorProfile;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = JWT_SECRET;

    mongoServer = await MongoMemoryServer.create({
      binary: { version: "7.0.0" },
      replSet: { count: 1 },
    });
    const uri = mongoServer.getUri();
    await mongoose.connect(uri);

    app = createTestApp();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    if (mongoServer) await mongoServer.stop();
  });

  beforeEach(async () => {
    await User.deleteMany({});
    await Vendor.deleteMany({});
    await Subscription.deleteMany({});
    await BuyerSubscription.deleteMany({});
    await Advertisement.deleteMany({});
    await Translation.deleteMany({});

    superAdminUser = await User.create({
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

    superAdminToken = jwt.sign(
      { userId: superAdminUser._id, role: superAdminUser.role },
      JWT_SECRET
    );
    vendorToken = jwt.sign(
      { userId: vendorUser._id, role: vendorUser.role },
      JWT_SECRET
    );
    buyerToken = jwt.sign(
      { userId: buyerUser._id, role: buyerUser.role },
      JWT_SECRET
    );

    vendorProfile = await Vendor.create({
      user: vendorUser._id,
      businessName: "Kigali Tech Store",
      phone: "0788000002",
      email: "vendor@kigali.rw",
      verificationStatus: "VERIFIED",
    });
  });

  describe("1. Vendor Subscription endpoints", () => {
    test("GET /api/vendor/subscription returns tiers on a Free plan", async () => {
      const res = await request(app)
        .get("/api/vendor/subscription")
        .set("Authorization", `Bearer ${vendorToken}`);

      expect(res.status).toBe(200);
      expect(res.body.tiers).toHaveLength(2);
      expect(res.body.tiers.map((t) => t.plan)).toContain("Vendor Premium");
      expect(res.body.subscription).toBeNull();
    });

    test("POST /api/vendor/subscription upgrades to Vendor Premium", async () => {
      const res = await request(app)
        .post("/api/vendor/subscription")
        .set("Authorization", `Bearer ${vendorToken}`)
        .send({ plan: "premium" });

      expect(res.status).toBe(200);
      expect(res.body.subscription.planKey).toBe("PREMIUM");
      expect(res.body.subscription.plan).toBe("Vendor Premium");
      expect(res.body.subscription.status).toBe("Active");
      expect(res.body.subscription.billing).toBe("Monthly");
      expect(res.body.subscription.renewal).not.toBe("—");

      const saved = await Subscription.findOne({ vendor: vendorUser._id });
      expect(saved.plan).toBe("PREMIUM");
      expect(saved.status).toBe("ACTIVE");
      expect(saved.price).toBe(15000);
    });

    test("POST /api/vendor/subscription downgrades back to Free", async () => {
      await Subscription.create({ vendor: vendorUser._id, plan: "PREMIUM", status: "ACTIVE", price: 15000, billingCycle: "MONTHLY" });

      const res = await request(app)
        .post("/api/vendor/subscription")
        .set("Authorization", `Bearer ${vendorToken}`)
        .send({ plan: "free" });

      expect(res.status).toBe(200);
      expect(res.body.subscription.planKey).toBe("FREE");
      expect(res.body.subscription.price).toBe(0);

      const saved = await Subscription.findOne({ vendor: vendorUser._id });
      expect(saved.plan).toBe("FREE");
    });

    test("Rejects buyer access to vendor subscription endpoints", async () => {
      const res = await request(app)
        .get("/api/vendor/subscription")
        .set("Authorization", `Bearer ${buyerToken}`);

      expect(res.status).toBe(403);
    });

    test("Requires authentication on vendor subscription endpoints", async () => {
      const res = await request(app).get("/api/vendor/subscription");
      expect(res.status).toBe(401);
    });
  });

  describe("2. Vendor Advertisement endpoints", () => {
    test("POST /api/vendor/advertisements submits a pending campaign", async () => {
      const res = await request(app)
        .post("/api/vendor/advertisements")
        .set("Authorization", `Bearer ${vendorToken}`)
        .send({
          product: "Samsung Galaxy S25",
          placement: "Homepage hero",
          budget: 150000,
        });

      expect(res.status).toBe(201);
      expect(res.body.advertisement.id).toBeDefined();
      expect(res.body.advertisement.status).toBe("Scheduled");
      expect(res.body.advertisement.placement).toBe("Homepage hero");

      const saved = await Advertisement.findOne({ vendor: vendorProfile._id });
      expect(saved.status).toBe("PENDING");
      expect(saved.budget).toBe(150000);
    });

    test("POST rejects missing product/budget", async () => {
      const res = await request(app)
        .post("/api/vendor/advertisements")
        .set("Authorization", `Bearer ${vendorToken}`)
        .send({ placement: "Homepage hero" });

      expect(res.status).toBe(400);
    });

    test("GET /api/vendor/advertisements lists only own campaigns", async () => {
      await Advertisement.create({
        vendor: vendorProfile._id,
        product: "Laptop Pro",
        placement: "SEARCH_RESULTS",
        budget: 90000,
        status: "ACTIVE",
        impressions: 400,
        clicks: 20,
      });

      const res = await request(app)
        .get("/api/vendor/advertisements")
        .set("Authorization", `Bearer ${vendorToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].product).toBe("Laptop Pro");
      expect(res.body.data[0].ctr).toBe("5.0%");
      expect(res.body.data[0].status).toBe("Active");
    });

    test("Vendor can pause and reactivate their own campaign", async () => {
      const ad = await Advertisement.create({
        vendor: vendorProfile._id,
        product: "Laptop Pro",
        placement: "SEARCH_RESULTS",
        budget: 90000,
        status: "ACTIVE",
      });

      const paused = await request(app)
        .patch(`/api/vendor/advertisements/${ad._id}/status`)
        .set("Authorization", `Bearer ${vendorToken}`)
        .send({ status: "PAUSED" });

      expect(paused.status).toBe(200);
      expect(paused.body.advertisement.status).toBe("Paused");

      const reactivated = await request(app)
        .patch(`/api/vendor/advertisements/${ad._id}/status`)
        .set("Authorization", `Bearer ${vendorToken}`)
        .send({ status: "ACTIVE" });

      expect(reactivated.status).toBe(200);
      expect(reactivated.body.advertisement.status).toBe("Active");
    });
  });

  describe("3. Buyer ad-removal subscription endpoints", () => {
    test("GET /api/buyer/subscription returns tiers on a Free plan", async () => {
      const res = await request(app)
        .get("/api/buyer/subscription")
        .set("Authorization", `Bearer ${buyerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.tiers).toHaveLength(2);
      expect(res.body.tiers.map((t) => t.plan)).toContain("Buyer Ad Removal");
      expect(res.body.subscription).toBeNull();
    });

    test("POST /api/buyer/subscription activates Premium ad removal", async () => {
      const res = await request(app)
        .post("/api/buyer/subscription")
        .set("Authorization", `Bearer ${buyerToken}`)
        .send({ plan: "premium" });

      expect(res.status).toBe(200);
      expect(res.body.subscription.planKey).toBe("PREMIUM");
      expect(res.body.subscription.plan).toBe("Buyer Ad Removal");
      expect(res.body.subscription.price).toBe(5000);
      expect(res.body.subscription.billing).toBe("Monthly");

      const saved = await BuyerSubscription.findOne({ buyer: buyerUser._id });
      expect(saved.plan).toBe("PREMIUM");
      expect(saved.price).toBe(5000);
    });

    test("POST /api/buyer/subscription cancels back to Free", async () => {
      await BuyerSubscription.create({
        buyer: buyerUser._id,
        plan: "PREMIUM",
        status: "ACTIVE",
        price: 5000,
        billingCycle: "MONTHLY",
      });

      const res = await request(app)
        .post("/api/buyer/subscription")
        .set("Authorization", `Bearer ${buyerToken}`)
        .send({ plan: "free" });

      expect(res.status).toBe(200);
      expect(res.body.subscription.planKey).toBe("FREE");
      expect(res.body.subscription.price).toBe(0);
    });

    test("Rejects vendor access to buyer subscription endpoints", async () => {
      const res = await request(app)
        .get("/api/buyer/subscription")
        .set("Authorization", `Bearer ${vendorToken}`);

      expect(res.status).toBe(403);
    });

    test("GET /api/admin/buyer-subscriptions lists buyer ad-removal plans", async () => {
      await BuyerSubscription.create({
        buyer: buyerUser._id,
        plan: "PREMIUM",
        status: "ACTIVE",
        price: 5000,
        billingCycle: "MONTHLY",
      });

      const res = await request(app)
        .get("/api/admin/buyer-subscriptions")
        .set("Authorization", `Bearer ${superAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].holder).toBe("Jean Paul");
      expect(res.body.data[0].type).toBe("Buyer Ad Removal");
    });
  });

  describe("4. Admin oversight endpoints", () => {
    test("GET /api/admin/subscriptions lists all vendor subscriptions", async () => {
      await Subscription.create({ vendor: vendorUser._id, plan: "PREMIUM", status: "ACTIVE", price: 15000, billingCycle: "MONTHLY" });

      const res = await request(app)
        .get("/api/admin/subscriptions")
        .set("Authorization", `Bearer ${superAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].holder).toBe("Kigali Tech Store");
      expect(res.body.data[0].type || res.body.data[0].plan).toBeDefined();
    });

    test("PATCH /api/admin/subscriptions/:id/status cancels a subscription", async () => {
      const sub = await Subscription.create({ vendor: vendorUser._id, plan: "PREMIUM", status: "ACTIVE", price: 15000, billingCycle: "MONTHLY" });

      const res = await request(app)
        .patch(`/api/admin/subscriptions/${sub._id}/status`)
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send({ status: "CANCELLED" });

      expect(res.status).toBe(200);
      expect(res.body.subscription.status).toBe("Cancelled");

      const saved = await Subscription.findById(sub._id);
      expect(saved.status).toBe("CANCELLED");
    });

    test("GET /api/admin/advertisements lists campaigns with vendor holder", async () => {
      await Advertisement.create({
        vendor: vendorProfile._id,
        product: "Office Chair Pro",
        placement: "SEARCH_RESULTS",
        budget: 95000,
        status: "ACTIVE",
      });

      const res = await request(app)
        .get("/api/admin/advertisements")
        .set("Authorization", `Bearer ${superAdminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].vendor).toBe("Kigali Tech Store");
    });

    test("PATCH /api/admin/advertisements/:id/status approves a PENDING campaign", async () => {
      const ad = await Advertisement.create({
        vendor: vendorProfile._id,
        product: "Sneakers",
        placement: "HOMEPAGE_HERO",
        budget: 100000,
        status: "PENDING",
      });

      const res = await request(app)
        .patch(`/api/admin/advertisements/${ad._id}/status`)
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send({ status: "ACTIVE" });

      expect(res.status).toBe(200);
      expect(res.body.advertisement.status).toBe("Active");

      const saved = await Advertisement.findById(ad._id);
      expect(saved.status).toBe("ACTIVE");
    });

    test("Denies vendor access to admin monetization routes", async () => {
      const res = await request(app)
        .get("/api/admin/subscriptions")
        .set("Authorization", `Bearer ${vendorToken}`);

      expect(res.status).toBe(403);
    });
  });

  describe("5. Localization endpoints", () => {
    test("GET /api/languages returns supported languages and dictionary", async () => {
      await Translation.create({
        key: "auth.login_title",
        module: "auth",
        translations: { en: "Sign in", rw: "Injira", fr: "Se connecter" },
      });

      const res = await request(app)
        .get("/api/languages?lang=rw")
        .expect(200);

      expect(res.body.supportedLanguages).toHaveLength(3);
      expect(res.body.currentLanguage).toBe("rw");
      expect(res.body.dictionary["auth.login_title"]).toBe("Injira");
    });

    test("GET /api/admin/translations lists translation keys", async () => {
      await Translation.create({
        key: "cart.checkout_btn",
        module: "cart",
        translations: { en: "Checkout", rw: "Isesengura", fr: "Paiement" },
      });

      const res = await request(app)
        .get("/api/admin/translations")
        .set("Authorization", `Bearer ${superAdminToken}`)
        .expect(200);

      expect(res.body.meta.total).toBe(1);
      expect(res.body.translations[0].key).toBe("cart.checkout_btn");
    });

    test("POST /api/admin/translations upserts a translation key", async () => {
      const res = await request(app)
        .post("/api/admin/translations")
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send({
          key: "home.hero",
          module: "common",
          translations: { en: "Welcome", rw: "Murakaza neza", fr: "Bienvenue" },
        })
        .expect(200);

      expect(res.body.translation.key).toBe("home.hero");

      const again = await request(app)
        .post("/api/admin/translations")
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send({
          key: "home.hero",
          module: "common",
          translations: { en: "Welcome back", rw: "Murakaza neza", fr: "Bon retour" },
        })
        .expect(200);

      expect(again.body.translation.translations.en).toBe("Welcome back");
      expect(await Translation.countDocuments({ key: "home.hero" })).toBe(1);
    });
  });
});