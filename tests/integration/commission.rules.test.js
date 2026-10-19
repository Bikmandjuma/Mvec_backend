require("../helpers/jest-shim"); // Jest-style API on node:test
const db = require("../helpers/mysql"); // MySQL test database (first, before models)
const request = require("supertest");
const jwt = require("jsonwebtoken");
const express = require("express");
const User = require("../../src/models/User");
const Vendor = require("../../src/models/Vendor");
const Category = require("../../src/models/Category");
const commission = require("../../src/services/commission.service");
const { computeRevenueSplit } = require("../../src/config/revenueSplit");

jest.setTimeout(60000);

describe("Commission rules: per category, seller overrides, configurable shares", () => {
  let app;
  let admin;
  let seller;
  let otherSeller;
  let phones;
  let shoes;
  const tokens = {};
  const secret = "commission_rules_test_secret";

  beforeAll(async () => {
    process.env.JWT_SECRET = secret;
    await db.setup();
    app = express();
    app.use(express.json());
    app.use(require("../../src/middleware/adminAudit"));
    app.use("/api/admin", require("../../src/routes/admin.commission.routes"));
    app.use("/api/vendors", require("../../src/routes/vendor.routes"));
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.reset();
    commission.clearCache();
    const make = (name, role, n) => User.create({ Fullname: name, companyName: role === "vendor" ? name : undefined, email: `${role}${n}@example.com`, password: "password123", phone: `078800001${n}`, gender: "female", role });
    admin = await make("Fee Admin", "super_admin", 1);
    seller = await make("Phone Shop", "vendor", 2);
    otherSeller = await make("Shoe Shop", "vendor", 3);
    await Vendor.create({ user: seller._id, businessName: "Phone Shop", phone: "0788000012", email: "vendor2@example.com" });
    phones = await Category.create({ name: "Phones", slug: "phones" });
    shoes = await Category.create({ name: "Shoes", slug: "shoes" });
    for (const [k, u] of Object.entries({ admin, seller, otherSeller })) tokens[k] = jwt.sign({ userId: u._id }, secret);
  });

  const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
  const rate = (vendorId, categoryId) => commission.resolveRate({ vendorId, categoryId }).then((r) => r.percent);

  test("defaults: 5% commission, 0.5% affiliate, and the platform keeps the developer share", () => {
    const s = computeRevenueSplit({ grossTotal: 100000, hasAffiliate: true, gatewayFee: 500 });
    expect(s.totalPlatformFee).toBe(5000);
    expect(s.developerShare).toBe(0);
    expect(s.platformAffiliateShare).toBe(500);
    expect(s.adminShare).toBe(4000); // 5000 − 500 affiliate − 500 provider fee
    expect(s.vendorNet).toBe(95000);
  });

  test("seller + category override > seller override > category rate > default; priority breaks ties; inactive rules are ignored", async () => {
    expect(await rate(seller._id, phones._id)).toBe(5);
    await commission.createRule({ ruleType: "CATEGORY", targetCategory: String(phones._id), rateValue: 8 });
    expect(await rate(seller._id, phones._id)).toBe(8);
    expect(await rate(seller._id, shoes._id)).toBe(5);

    await commission.createRule({ ruleType: "VENDOR", targetVendor: String(seller._id), rateValue: 4 });
    expect(await rate(seller._id, phones._id)).toBe(4);
    expect(await rate(otherSeller._id, phones._id)).toBe(8);

    const special = await commission.createRule({ ruleType: "VENDOR", targetVendor: String(seller._id), targetCategory: String(phones._id), rateValue: 2.5 });
    expect(await rate(seller._id, phones._id)).toBe(2.5);
    expect(await rate(seller._id, shoes._id)).toBe(4);

    await commission.createRule({ ruleType: "CATEGORY", targetCategory: String(shoes._id), rateValue: 7, priority: 1 });
    await commission.createRule({ ruleType: "CATEGORY", targetCategory: String(shoes._id), rateValue: 9, priority: 5 });
    expect(await rate(otherSeller._id, shoes._id)).toBe(9);

    await commission.setActive(String(special._id), false);
    expect(await rate(seller._id, phones._id)).toBe(4);
  });

  test("settings change the shares and who pays provider fees", async () => {
    await commission.updateSettings({ developerSharePercent: 30, affiliateSharePercent: 20, gatewayFeePayer: "SELLER" });
    await commission.createRule({ ruleType: "CATEGORY", targetCategory: String(phones._id), rateValue: 10 });
    const s = await commission.splitFor({ vendorId: seller._id, categoryId: phones._id, grossTotal: 100000, hasAffiliate: true, gatewayFee: 1000, vendorAffiliatePercent: 2 });
    expect(s.totalPlatformFee).toBe(10000);
    expect(s.developerShare).toBe(3000);
    expect(s.platformAffiliateShare).toBe(2000);
    expect(s.vendorAffiliateShare).toBe(2000);
    expect(s.adminShare).toBe(5000); // provider fee is not taken from MVEC
    expect(s.vendorNet).toBe(100000 - 10000 - 2000 - 1000);
    expect(s.gatewayFeePayer).toBe("SELLER");
    // Every franc is accounted for.
    expect(s.vendorNet + s.totalPlatformFee + s.vendorAffiliateShare + s.gatewayFee).toBe(100000);

    let message = "";
    try { await commission.updateSettings({ developerSharePercent: 70, affiliateSharePercent: 40 }); } catch (err) { message = err.message; }
    expect(message).toMatch(/cannot be more than 100%/);
  });

  test("admins create, edit, prioritise, switch off and delete rules; others cannot", async () => {
    const denied = await request(app).post("/api/admin/commissions").set(as("seller")).send({ ruleType: "CATEGORY", targetCategory: String(phones._id), rateValue: 6 });
    expect(denied.status).toBe(403);

    const bad = await request(app).post("/api/admin/commissions").set(as("admin")).send({ ruleType: "CATEGORY", rateValue: 6 });
    expect(bad.status).toBe(400);
    const tooHigh = await request(app).post("/api/admin/commissions").set(as("admin")).send({ ruleType: "CATEGORY", targetCategory: String(phones._id), rateValue: 80 });
    expect(tooHigh.status).toBe(400);

    const created = await request(app).post("/api/admin/commissions").set(as("admin")).send({ ruleType: "CATEGORY", targetCategory: String(phones._id), rateValue: 6 });
    expect(created.status).toBe(201);
    const id = created.body.rule._id || created.body.rule.id;

    const edited = await request(app).put(`/api/admin/commissions/${id}`).set(as("admin")).send({ rateValue: 7.5, priority: 3 });
    expect(edited.status).toBe(200);
    expect(await rate(seller._id, phones._id)).toBe(7.5);

    const list = await request(app).get("/api/admin/commissions").set(as("admin"));
    expect(list.body.rules[0].categoryName).toBe("Phones");
    expect(list.body.settings.defaultCommissionPercent).toBe(5);

    const preview = await request(app).get(`/api/admin/commissions/preview?vendorId=${seller._id}&categoryId=${phones._id}&amount=200000`).set(as("admin"));
    expect(preview.body.totalPlatformFee).toBe(15000);
    expect(preview.body.source).toBe("Category rate");

    const off = await request(app).patch(`/api/admin/commissions/${id}/toggle`).set(as("admin")).send({ isActive: false });
    expect(off.body.rule.isActive).toBe(false);
    expect(await rate(seller._id, phones._id)).toBe(5);

    const removed = await request(app).delete(`/api/admin/commissions/${id}`).set(as("admin"));
    expect(removed.status).toBe(200);

    const settings = await request(app).put("/api/admin/commission-settings").set(as("admin")).send({ defaultCommissionPercent: 6, gatewayFeePayer: "NOBODY" });
    expect(settings.status).toBe(400);
  });

  test("a seller sees the rate they pay in every category", async () => {
    await commission.createRule({ ruleType: "CATEGORY", targetCategory: String(phones._id), rateValue: 8 });
    await commission.createRule({ ruleType: "VENDOR", targetVendor: String(seller._id), targetCategory: String(shoes._id), rateValue: 3 });
    const res = await request(app).get("/api/vendors/me/fees").set(as("seller"));
    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.categories.map((c) => [c.category, c]));
    expect(byName.Phones.percent).toBe(8);
    expect(byName.Shoes.percent).toBe(3);
    expect(byName.Shoes.source).toMatch(/Seller override/);
    expect(res.body.defaultPercent).toBe(5);
  });
});
