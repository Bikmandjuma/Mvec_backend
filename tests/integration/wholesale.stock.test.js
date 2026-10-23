require("../helpers/jest-shim"); // Jest-style API on node:test
const db = require("../helpers/mysql"); // MySQL test database (first, before models)
const request = require("supertest");
const jwt = require("jsonwebtoken");
const express = require("express");
const User = require("../../src/models/User");
const Vendor = require("../../src/models/Vendor");
const Store = require("../../src/models/Store");
const Product = require("../../src/models/Product");
const StockMovement = require("../../src/models/StockMovement");
const Supplier = require("../../src/models/Supplier");
const SupplierTeamMember = require("../../src/models/SupplierTeamMember");
const WholesaleProduct = require("../../src/models/WholesaleProduct");
const WholesaleOrder = require("../../src/models/WholesaleOrder");
const Category = require("../../src/models/Category");
const SupplierStore = require("../../src/models/SupplierStore");
const commission = require("../../src/services/commission.service");
const wholesale = require("../../src/services/wholesale.service");

jest.setTimeout(90000);

describe("Wholesale stock: purchases land in the vendor's store; suppliers manage stock like vendors", () => {
  let app;
  let vendor;
  let supplierUser;
  let warehouse;
  let viewer;
  let supplier;
  let product;
  let mainStore;
  let branch;
  let food;
  const tokens = {};
  const secret = "wholesale_stock_secret";

  beforeAll(async () => {
    process.env.JWT_SECRET = secret;
    delete process.env.PAYPACK_CLIENT_ID; // sandbox payments
    await db.setup();
    app = express();
    app.use(express.json());
    app.use("/api/wholesale", require("../../src/routes/wholesale.routes"));
    app.use("/api/suppliers", require("../../src/routes/supplier.routes"));
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.reset();
    commission.clearCache();
    const make = (name, role, n) => User.create({ Fullname: name, companyName: name, email: `${role}${n}@example.com`, password: "password123", phone: `07880004${String(n).padStart(2, "0")}`, gender: "male", role, isOnboarded: true });
    vendor = await make("Corner Shop", "vendor", 1);
    supplierUser = await make("Rice Supplier", "supplier", 2);
    warehouse = await make("Warehouse Worker", "supplier", 3);
    viewer = await make("Viewer Member", "supplier", 4);
    await Vendor.create({ user: vendor._id, businessName: "Corner Shop", phone: "0788000401", email: "vendor1@example.com", description: "A corner shop.", logoUrl: "/l.png", category: "Food", location: "Kigali", verificationStatus: "VERIFIED" });
    mainStore = await Store.create({ vendor: vendor._id, isPrimary: true, storeName: "Corner Shop", slug: "corner-shop", contactEmail: "vendor1@example.com", contactPhone: "0788000401", status: "ACTIVE" });
    branch = await Store.create({ vendor: vendor._id, storeName: "Corner Shop Musanze", slug: "corner-shop-musanze", contactEmail: "vendor1@example.com", contactPhone: "0788000401", status: "ACTIVE" });
    supplier = await Supplier.create({ user: supplierUser._id, businessName: "Rice Supplier", phone: "0788000402", email: "supplier2@example.com", description: "Rice in bulk.", logoUrl: "/l.png", category: "Food", location: "Kigali", verificationStatus: "VERIFIED", status: "ACTIVE" });
    await SupplierTeamMember.create({ supplier: supplier._id, user: warehouse._id, fullName: "Warehouse Worker", phone: "0788000403", role: "WAREHOUSE", status: "ACTIVE" });
    await SupplierTeamMember.create({ supplier: supplier._id, user: viewer._id, fullName: "Viewer Member", phone: "0788000404", role: "VIEWER", status: "ACTIVE" });
    food = await Category.create({ name: "Food", slug: "food" });
    product = await WholesaleProduct.create({ supplier: supplier._id, name: "Rice 25kg", category: "food", unit: "bag", wholesalePrice: 30000, retailPrice: 36000, moq: 2, stockQuantity: 10, shortDescription: "Long grain rice.", media: { mainImage: "/rice.png", gallery: [] }, status: "ACTIVE" });
    for (const [k, u] of Object.entries({ vendor, supplierUser, warehouse, viewer })) tokens[k] = jwt.sign({ userId: u._id }, secret);
  });

  const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
  const buy = async (qty, storeId) => {
    const placed = await request(app).post("/api/wholesale/orders").set(as("vendor")).send({ supplierId: String(supplier._id), items: [{ productId: String(product._id), quantity: qty }], ...(storeId ? { storeId: String(storeId) } : {}) });
    expect(placed.status).toBe(201);
    const o = placed.body.data;
    expect((await request(app).post(`/api/wholesale/orders/${o._id}/pay`).set(as("vendor")).send({ method: "momo", phoneNumber: "0788123456" })).body.status).toBe("SUCCESS");
    expect((await request(app).post(`/api/wholesale/orders/${o._id}/ship`).set(as("supplierUser"))).status).toBe(200);
    return o;
  };
  const confirm = (o) => request(app).post(`/api/wholesale/orders/${o._id}/confirm-receipt`).set(as("vendor"));

  test("confirming receipt lists the goods in the primary store, then restocks the same product", async () => {
    const first = await buy(3);
    const done = await confirm(first);
    expect(done.status).toBe(200);
    expect(done.body.message).toMatch(/3 units were added to your inventory/);

    const listed = await Product.find({ vendor: vendor._id });
    expect(listed.length).toBe(1);
    const p = listed[0];
    expect(p.name).toBe("Rice 25kg");
    expect(p.stockQuantity).toBe(3);
    expect(p.price).toBe(36000); // the supplier's suggested retail price
    expect(p.costPrice).toBe(30000);
    expect(p.status).toBe("ACTIVE");
    expect(String(p.category)).toBe(String(food._id));
    expect(String(p.wholesaleProduct)).toBe(String(product._id));
    expect((await WholesaleOrder.findById(first._id)).stockedAt).toBeTruthy();

    const second = await buy(2);
    await confirm(second);
    const again = await Product.find({ vendor: vendor._id });
    expect(again.length).toBe(1);
    expect(again[0].stockQuantity).toBe(5);

    const moves = await StockMovement.find({ vendor: vendor._id }).sort({ createdAt: 1 });
    expect(moves.map((m) => [m.type, m.reason, m.before, m.after])).toEqual([["RESTOCK", "Received from supplier", 0, 3], ["RESTOCK", "Received from supplier", 3, 5]]);
    expect(moves[1].note).toMatch(/Wholesale order WSO-/);
  });

  test("a stocking failure part-way adds nothing; the admin retry adds it once", async () => {
    await confirm(await buy(3));
    const second = await buy(2);

    // The stock is raised, then recording the movement fails: all of it rolls back.
    const realCreate = StockMovement.create;
    StockMovement.create = async () => { throw new Error("disk full"); };
    try {
      expect((await confirm(second)).status).toBe(200); // the supplier is still paid
    } finally {
      StockMovement.create = realCreate;
    }
    expect((await Product.findOne({ vendor: vendor._id })).stockQuantity).toBe(3);
    expect((await WholesaleOrder.findById(second._id)).stockedAt).toBeFalsy();

    await wholesale.restockCompletedOrder(second._id);
    expect((await Product.findOne({ vendor: vendor._id })).stockQuantity).toBe(5);
    expect(await StockMovement.countDocuments({ vendor: vendor._id, note: `Wholesale order ${second.orderNumber}` })).toBe(1);
    const repeat = await wholesale.restockCompletedOrder(second._id).catch((e) => e);
    expect(repeat.statusCode).toBe(409);
  });

  test("goods go to the store chosen at ordering, and never twice", async () => {
    const o = await buy(2, branch._id);
    await confirm(o);
    const p = await Product.findOne({ vendor: vendor._id });
    expect(String(p.store)).toBe(String(branch._id));
    const repeat = await wholesale.restockCompletedOrder(o._id).catch((e) => e);
    expect(repeat.statusCode).toBe(409);
    expect((await Product.findById(p._id)).stockQuantity).toBe(2);

    // Another vendor's store is refused.
    const bad = await request(app).post("/api/wholesale/orders").set(as("vendor")).send({ supplierId: String(supplier._id), items: [{ productId: String(product._id), quantity: 2 }], storeId: "6a0000000000000000000abc" });
    expect(bad.status).toBe(400);
  });

  test("automatic release after 7 days also stocks the store", async () => {
    await buy(2);
    const later = new Date(Date.now() + 8 * 24 * 3600 * 1000);
    expect((await wholesale.runAutomations(later)).released).toBe(1);
    expect((await Product.findOne({ vendor: vendor._id })).stockQuantity).toBe(2);
  });

  test("without a suggested retail price the product waits as a draft", async () => {
    await WholesaleProduct.updateOne({ _id: product._id }, { $set: { retailPrice: 0 } });
    await confirm(await buy(2));
    const p = await Product.findOne({ vendor: vendor._id });
    expect(p.status).toBe("DRAFT");
    expect(p.stockQuantity).toBe(2);
  });

  test("suppliers add, remove and count stock with history; viewers cannot", async () => {
    const url = `/api/suppliers/me/products/${product._id}/stock`;
    expect((await request(app).patch(url).set(as("viewer")).send({ mode: "add", quantity: 5 })).status).toBe(403);
    const added = await request(app).patch(url).set(as("warehouse")).send({ mode: "add", quantity: 5, reason: "Restock", note: "Harvest" });
    expect(added.status).toBe(200);
    expect(added.body.product.stockQuantity).toBe(15);
    expect((await request(app).patch(url).set(as("supplierUser")).send({ mode: "remove", quantity: 99 })).status).toBe(409);
    const zero = await request(app).patch(url).set(as("supplierUser")).send({ mode: "set", quantity: 0 });
    expect(zero.body.product.status).toBe("OUT_OF_STOCK");
    const back = await request(app).patch(url).set(as("supplierUser")).send({ mode: "add", quantity: 4 });
    expect(back.body.product.status).toBe("ACTIVE");

    const edit = await request(app).put(`/api/suppliers/me/products/${product._id}`).set(as("supplierUser")).send({ stockQuantity: 20, lowStockThreshold: 6 });
    expect(edit.status).toBe(200);
    expect(edit.body.product.lowStockThreshold).toBe(6);

    const history = await request(app).get("/api/suppliers/me/stock-movements").set(as("warehouse"));
    expect(history.status).toBe(200);
    expect(history.body.movements.map((m) => [m.type, m.quantity])).toEqual([["COUNT", 16], ["RESTOCK", 4], ["COUNT", -15], ["RESTOCK", 5]]);
    expect(history.body.reasons.REMOVE).toContain("Sold outside MVEC");
  });

  test("selling out a supplier product marks it out of stock; cancelling brings it back", async () => {
    const placed = await request(app).post("/api/wholesale/orders").set(as("vendor")).send({ supplierId: String(supplier._id), items: [{ productId: String(product._id), quantity: 10 }] });
    expect((await WholesaleProduct.findById(product._id)).status).toBe("OUT_OF_STOCK");
    await request(app).post(`/api/wholesale/orders/${placed.body.data._id}/cancel`).set(as("vendor"));
    const restored = await WholesaleProduct.findById(product._id);
    expect(restored.stockQuantity).toBe(10);
    expect(restored.status).toBe("ACTIVE");
  });

  test("supplier stores work like vendor stores: primary from the profile, register, move products, primary switch, delete", async () => {
    const list = await request(app).get("/api/suppliers/me/stores").set(as("warehouse"));
    expect(list.status).toBe(200);
    expect(list.body.stores.length).toBe(1);
    const main = list.body.stores[0];
    expect(main.storeName).toBe("Rice Supplier");
    expect(main.isPrimary).toBe(true);
    expect(main.productCount).toBe(1);
    expect(main.address.city).toBe("Kigali");

    // Only owners change stores; warehouse staff can't.
    const body = { storeName: "Musanze Depot", contactEmail: "depot@example.com", contactPhone: "0788000499", city: "Musanze", businessAddress: "Market street" };
    expect((await request(app).post("/api/suppliers/me/stores").set(as("warehouse")).send(body)).status).toBe(403);
    const made = await request(app).post("/api/suppliers/me/stores").set(as("supplierUser")).send(body);
    expect(made.status).toBe(201);
    const depot = made.body.store;
    expect(depot.isPrimary).toBe(false);
    expect(depot.address.city).toBe("Musanze");

    const edited = await request(app).put(`/api/suppliers/me/stores/${depot._id}`).set(as("supplierUser")).send({ city: "Rubavu", description: "Lake side" });
    expect(edited.body.store.address.city).toBe("Rubavu");

    // Warehouse staff move stock between stores; the transfer is in the history.
    const moved = await request(app).post("/api/suppliers/me/products/move-store").set(as("warehouse")).send({ productIds: [String(product._id)], storeId: depot._id });
    expect(moved.status).toBe(200);
    expect(String((await WholesaleProduct.findById(product._id)).store)).toBe(String(depot._id));
    const transfer = await StockMovement.findOne({ product: product._id, type: "TRANSFER" });
    expect(transfer.note).toBe("Rice Supplier → Musanze Depot");

    // Vendors see where it ships from.
    const catalog = await request(app).get(`/api/suppliers/${supplier._id}/products`);
    expect(catalog.body.products[0].shipsFrom).toEqual({ storeName: "Musanze Depot", city: "Rubavu" });

    // New products go to a chosen store; someone else's store is refused.
    const created = await request(app).post("/api/suppliers/me/products").set(as("supplierUser")).send({ name: "Beans 50kg", wholesalePrice: 40000, storeId: depot._id });
    expect(String(created.body.product.store)).toBe(String(depot._id));
    expect((await request(app).post("/api/suppliers/me/products").set(as("supplierUser")).send({ name: "Maize", wholesalePrice: 1, storeId: String(mainStore._id) })).status).toBe(400);

    expect((await request(app).delete(`/api/suppliers/me/stores/${main._id}`).set(as("supplierUser"))).status).toBe(400);
    expect((await request(app).patch(`/api/suppliers/me/stores/${depot._id}/primary`).set(as("supplierUser"))).status).toBe(200);
    const gone = await request(app).delete(`/api/suppliers/me/stores/${main._id}`).set(as("supplierUser"));
    expect(gone.status).toBe(200);
    expect(await SupplierStore.countDocuments({ supplier: supplier._id })).toBe(1);
    expect((await WholesaleProduct.find({ supplier: supplier._id })).every((p) => String(p.store) === String(depot._id))).toBe(true);
  });
});
