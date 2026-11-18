require("../helpers/jest-shim"); // Jest-style API on node:test
const db = require("../helpers/mysql"); // MySQL test database (first, before models)
const request = require("supertest");
const jwt = require("jsonwebtoken");
const express = require("express");
const User = require("../../src/models/User");
const Vendor = require("../../src/models/Vendor");
const Supplier = require("../../src/models/Supplier");
const Product = require("../../src/models/Product");
const WholesaleProduct = require("../../src/models/WholesaleProduct");
const Category = require("../../src/models/Category");

jest.setTimeout(90000);

// Sellers work from sign-up; buyers see their products once Ikiguzi approves them.
describe("Products wait for the seller's approval", () => {
  let app;
  let vendorUser;
  let vendor;
  let category;
  const tokens = {};
  const secret = "listing_approval_secret";

  beforeAll(async () => {
    process.env.JWT_SECRET = secret;
    await db.setup();
    app = express();
    app.use(express.json());
    app.use("/api/products", require("../../src/routes/product.routes"));
    app.use("/api/admin/vendors", require("../../src/routes/admin.vendor.routes"));
    app.use("/api/suppliers", require("../../src/routes/supplier.routes"));
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.reset();
    const make = (name, role, n) => User.create({ Fullname: name, companyName: name, email: `${role}${n}@example.com`, password: "password123", phone: `07880006${String(n).padStart(2, "0")}`, gender: "male", role, isOnboarded: true });
    vendorUser = await make("New Shop", "vendor", 1);
    const admin = await make("Ikiguzi Admin", "super_admin", 2);
    const supplierUser = await make("New Supplier", "supplier", 3);
    vendor = await Vendor.create({ user: vendorUser._id, businessName: "New Shop", phone: "0788000601", email: "vendor1@example.com", description: "Shoes.", logoUrl: "/l.png", category: "Fashion", location: "Kigali", verificationStatus: "PENDING" });
    await Supplier.create({ user: supplierUser._id, businessName: "New Supplier", phone: "0788000603", email: "supplier3@example.com", description: "Rice.", logoUrl: "/l.png", category: "Food", location: "Kigali", verificationStatus: "PENDING", status: "ACTIVE" });
    category = await Category.create({ name: "Fashion", slug: "fashion" });
    for (const [k, u] of Object.entries({ vendorUser, admin, supplierUser })) tokens[k] = jwt.sign({ userId: u._id }, secret);
  });

  const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
  const create = (body) => request(app).post("/api/products").set(as("vendorUser")).send({ name: "Leather shoes", description: "Brown leather shoes.", price: 25000, stockQuantity: 4, category: String(category._id), mainImage: "/shoes.png", status: "ACTIVE", ...body });
  const publicIds = async () => (await request(app).get("/api/products")).body.products.map((p) => String(p._id));

  test("an unapproved seller's products are saved, editable and hidden until the admin approves the seller", async () => {
    const res = await create();
    expect(res.status).toBe(201);
    expect(res.body.waitingForApproval).toBe(true);
    expect(res.body.message).toContain("once Ikiguzi approves");
    const id = String(res.body.product._id);
    expect(res.body.product.status).toBe("PENDING_APPROVAL");

    // Hidden from buyers, visible to the seller.
    expect(await publicIds()).not.toContain(id);
    expect((await request(app).get(`/api/products/${id}`)).status).toBe(404);
    const mine = await request(app).get("/api/products/vendor/me").set(as("vendorUser"));
    expect(mine.body.products.map((p) => String(p._id))).toContain(id);

    // Edits, a sell-out and asking for ACTIVE all keep it waiting.
    const edit = await request(app).put(`/api/products/${id}`).set(as("vendorUser")).send({ price: 24000, stockQuantity: 0, status: "ACTIVE" });
    expect(edit.status).toBe(200);
    expect(edit.body.product.status).toBe("PENDING_APPROVAL");
    await request(app).put(`/api/products/${id}`).set(as("vendorUser")).send({ stockQuantity: 6 });
    expect((await Product.findById(id)).status).toBe("PENDING_APPROVAL");

    // A draft stays a draft.
    const draft = (await create({ name: "Sandals", status: "DRAFT" })).body.product;
    expect(draft.status).toBe("DRAFT");

    // Approval: buyers see it; rejection later takes it off again.
    const verified = await request(app).patch(`/api/admin/vendors/${vendor._id}/verify`).set(as("admin")).send({ decision: "VERIFIED" });
    expect(verified.status).toBe(200);
    expect(verified.body.productsChanged).toBe(1);
    expect((await Product.findById(id)).status).toBe("ACTIVE");
    expect((await Product.findById(draft._id)).status).toBe("DRAFT");
    expect(await publicIds()).toContain(id);

    const later = (await create({ name: "Boots" })).body.product;
    expect(later.status).toBe("ACTIVE");

    const rejected = await request(app).patch(`/api/admin/vendors/${vendor._id}/verify`).set(as("admin")).send({ decision: "REJECTED", reason: "Add a clear store logo." });
    expect(rejected.status).toBe(200);
    expect(await publicIds()).toEqual([]);
  });

  test("an unverified supplier can put stock on the marketplace; buyers see it once verified", async () => {
    const supplier = await Supplier.findOne({ user: (await User.findOne({ role: "supplier" }))._id });
    await Category.create({ name: "Food", slug: "food" });
    const rice = await WholesaleProduct.create({ supplier: supplier._id, name: "Rice 5kg", category: "Food", unit: "bag", wholesalePrice: 6000, retailPrice: 8000, moq: 10, stockQuantity: 50, shortDescription: "Long grain rice.", media: { mainImage: "/rice.png", gallery: [] }, status: "ACTIVE" });
    const res = await request(app).post(`/api/suppliers/me/products/${rice._id}/publish`).set(as("supplierUser")).send({ price: 8500, units: 5 });
    expect(res.status).toBe(200);
    expect(res.body.waitingForApproval).toBe(true);
    expect(res.body.listing.status).toBe("PENDING_APPROVAL");
    expect(await publicIds()).toEqual([]);

    await require("../../src/services/listingApproval.service").followDecision(supplier.user, "VERIFIED");
    expect(await publicIds()).toEqual([String(res.body.listing._id)]);
  });
});
