require("../helpers/jest-shim"); // Jest-style API on node:test
const db = require("../helpers/mysql"); // MySQL test database (first, before models)
const request = require("supertest");
const jwt = require("jsonwebtoken");
const express = require("express");
const User = require("../../src/models/User");
const Store = require("../../src/models/Store");
const Product = require("../../src/models/Product");
const Order = require("../../src/models/Order");
const VendorWallet = require("../../src/models/VendorWallet");
const Supplier = require("../../src/models/Supplier");
const SupplierTeamMember = require("../../src/models/SupplierTeamMember");
const WholesaleProduct = require("../../src/models/WholesaleProduct");
const StockMovement = require("../../src/models/StockMovement");
const Category = require("../../src/models/Category");
const commission = require("../../src/services/commission.service");

jest.setTimeout(90000);

describe("Suppliers sell published products to buyers", () => {
  let app;
  let supplierUser;
  let warehouse;
  let supplier;
  let product;
  const tokens = {};
  const secret = "supplier_retail_secret";
  const delivery = {
    shippingAddress: { street: "KG 11 Ave 18", district: "Gasabo", sector: "Remera", province: "Kigali City" },
    recipient: { name: "Aline Uwase", phone: "0788123456", email: "aline@example.com" },
    deliveryMethod: "standard",
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = secret;
    delete process.env.PAYPACK_CLIENT_ID; // sandbox payments
    await db.setup();
    app = express();
    app.use(express.json());
    app.use("/api/suppliers", require("../../src/routes/supplier.routes"));
    app.use("/api/products", require("../../src/routes/product.routes"));
    app.use("/api/orders", require("../../src/routes/order.routes"));
    app.use("/api/payments", require("../../src/routes/payment.routes"));
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.reset();
    commission.clearCache();
    const make = (name, role, n) => User.create({ Fullname: name, companyName: name, email: `${role}${n}@example.com`, password: "password123", phone: `07880005${String(n).padStart(2, "0")}`, gender: "male", role, isOnboarded: true });
    supplierUser = await make("Rice Supplier", "supplier", 1);
    warehouse = await make("Warehouse Worker", "supplier", 2);
    const buyer = await make("Aline Buyer", "buyer", 3);
    const otherSupplier = await make("Other Supplier", "supplier", 4);
    const viewer = await make("Team Viewer", "supplier", 5);
    supplier = await Supplier.create({ user: supplierUser._id, businessName: "Rice Supplier", phone: "0788000501", email: "supplier1@example.com", description: "Rice in bulk.", logoUrl: "/l.png", category: "Food", location: "Kigali", verificationStatus: "VERIFIED", status: "ACTIVE" });
    await Supplier.create({ user: otherSupplier._id, businessName: "Other Supplier", phone: "0788000504", email: "supplier4@example.com", description: "Beans.", logoUrl: "/l.png", category: "Food", location: "Kigali", verificationStatus: "VERIFIED", status: "ACTIVE" });
    await SupplierTeamMember.create({ supplier: supplier._id, user: warehouse._id, fullName: "Warehouse Worker", phone: "0788000502", role: "WAREHOUSE", status: "ACTIVE" });
    await SupplierTeamMember.create({ supplier: supplier._id, user: viewer._id, fullName: "Team Viewer", phone: "0788000505", role: "VIEWER", status: "ACTIVE" });
    await Category.create({ name: "Food", slug: "food" });
    product = await WholesaleProduct.create({ supplier: supplier._id, name: "Rice 5kg", category: "Food", unit: "bag", wholesalePrice: 6000, retailPrice: 8000, moq: 10, stockQuantity: 50, shortDescription: "Long grain rice.", media: { mainImage: "/rice.png", gallery: [] }, status: "ACTIVE" });
    for (const [k, u] of Object.entries({ supplierUser, warehouse, buyer, otherSupplier, viewer })) tokens[k] = jwt.sign({ userId: u._id }, secret);
  });

  const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
  const publish = (body) => request(app).post(`/api/suppliers/me/products/${product._id}/publish`).set(as("supplierUser")).send(body);

  test("publishing moves units to a marketplace listing buyers can see in the supplier's shop", async () => {
    expect((await publish({ price: 8500, units: 999 })).status).toBe(409);
    expect((await publish({ price: 0, units: 5 })).status).toBe(400);
    const res = await publish({ price: 8500, units: 12 });
    expect(res.status).toBe(200);
    expect(res.body.product.stockQuantity).toBe(38);

    const listing = await Product.findById(res.body.listing._id);
    expect(listing.status).toBe("ACTIVE");
    expect(listing.price).toBe(8500);
    expect(listing.stockQuantity).toBe(12);
    expect(String(listing.vendor)).toBe(String(supplierUser._id));
    const shop = await Store.findOne({ vendor: supplierUser._id });
    expect(shop.storeName).toBe("Rice Supplier");
    expect(String(listing.store)).toBe(String(shop._id));

    const publicList = await request(app).get("/api/products");
    expect(publicList.body.products.map((p) => p.name)).toContain("Rice 5kg");

    // More units and a new price go to the same listing.
    await publish({ price: 9000, units: 3 });
    expect(await Product.countDocuments({ vendor: supplierUser._id })).toBe(1);
    const again = await Product.findById(listing._id);
    expect([again.price, again.stockQuantity]).toEqual([9000, 15]);
    expect((await WholesaleProduct.findById(product._id)).stockQuantity).toBe(35);

    // Units can come back to wholesale stock; unpublishing returns the rest.
    const back = await request(app).post(`/api/suppliers/me/products/${product._id}/listing-stock`).set(as("supplierUser")).send({ mode: "remove", units: 5 });
    expect(back.status).toBe(200);
    expect((await WholesaleProduct.findById(product._id)).stockQuantity).toBe(40);
    const off = await request(app).post(`/api/suppliers/me/products/${product._id}/unpublish`).set(as("supplierUser"));
    expect(off.body.returned).toBe(10);
    expect((await Product.findById(listing._id)).status).toBe("INACTIVE");
    expect((await WholesaleProduct.findById(product._id)).stockQuantity).toBe(50);
    expect(await StockMovement.countDocuments({ product: product._id, reason: "Put on the marketplace" })).toBe(2);
  });

  test("a buyer buys it; the supplier sees the order, ships it and is paid into their balance", async () => {
    const { listing } = (await publish({ price: 8000, units: 5 })).body;
    const bought = await request(app).post("/api/orders/direct-checkout").set(as("buyer")).send({ ...delivery, items: [{ productId: String(listing._id), quantity: 2 }] });
    expect(bought.status).toBe(201);
    const id = bought.body.order.id;
    expect((await request(app).post("/api/payments/pay").set(as("buyer")).send({ orderId: id, phoneNumber: "0788123456" })).body.status).toBe("SUCCESS");

    // Their team sees it; another supplier does not.
    const mine = await request(app).get("/api/orders/vendor/orders").set(as("warehouse"));
    expect(mine.status).toBe(200);
    expect(mine.body.orders.map((o) => String(o._id))).toEqual([String(id)]);
    expect((await request(app).get("/api/orders/vendor/orders").set(as("otherSupplier"))).body.orders.length).toBe(0);
    expect((await request(app).get("/api/orders/deliverable").set(as("otherSupplier"))).body.orders?.length || 0).toBe(0);

    const shipped = await request(app).patch("/api/orders/vendor/status").set(as("warehouse")).send({ orderId: id, status: "SHIPPED" });
    expect(shipped.status).toBe(200);
    const { deliveryOtp } = await Order.findById(id);
    const delivered = await request(app).patch(`/api/orders/${id}/deliver`).set(as("supplierUser")).send({ deliveryOtp });
    expect(delivered.status).toBe(200);
    const wallet = await VendorWallet.findOne({ vendor: supplierUser._id });
    expect(wallet.availableBalance + wallet.pendingBalance).toBeGreaterThan(0);
  });

  test("the supplier's team works on retail orders as the owner; read-only roles can only look", async () => {
    const { listing } = (await publish({ price: 8000, units: 6 })).body;
    const buyAndPay = async () => {
      const bought = await request(app).post("/api/orders/direct-checkout").set(as("buyer")).send({ ...delivery, items: [{ productId: String(listing._id), quantity: 1 }] });
      expect(bought.status).toBe(201);
      await request(app).post("/api/payments/pay").set(as("buyer")).send({ orderId: bought.body.order.id, phoneNumber: "0788123456" });
      return bought.body.order.id;
    };
    const toDeliver = await buyAndPay();
    const toCancel = await buyAndPay();

    // A viewer can read the orders but not change them.
    const seen = await request(app).get("/api/orders/vendor/orders").set(as("viewer"));
    expect(seen.status).toBe(200);
    expect(seen.body.orders.length).toBe(2);
    expect((await request(app).get("/api/orders/deliverable").set(as("viewer"))).status).toBe(200);
    expect((await request(app).patch("/api/orders/vendor/status").set(as("viewer")).send({ orderId: toCancel, status: "CANCELLED" })).status).toBe(403);

    // A team member with "supply" sees deliverable orders, cancels and confirms delivery for the owner.
    const deliverable = await request(app).get("/api/orders/deliverable").set(as("warehouse"));
    expect(deliverable.body.orders.map((o) => String(o._id)).sort()).toEqual([String(toDeliver), String(toCancel)].sort());
    const cancelled = await request(app).patch("/api/orders/vendor/status").set(as("warehouse")).send({ orderId: toCancel, status: "CANCELLED" });
    expect(cancelled.status).toBe(200);
    expect((await Order.findById(toCancel)).orderStatus).toBe("CANCELLED");

    await request(app).patch("/api/orders/vendor/status").set(as("warehouse")).send({ orderId: toDeliver, status: "SHIPPED" });
    const { deliveryOtp } = await Order.findById(toDeliver);
    expect((await request(app).patch(`/api/orders/${toDeliver}/deliver`).set(as("viewer")).send({ deliveryOtp })).status).toBe(403);
    const delivered = await request(app).patch(`/api/orders/${toDeliver}/deliver`).set(as("warehouse")).send({ deliveryOtp });
    expect(delivered.status).toBe(200);
  });

  test("unverified suppliers cannot publish; viewers of the catalog can't either", async () => {
    await Supplier.updateOne({ _id: supplier._id }, { $set: { verificationStatus: "PENDING" } });
    expect((await publish({ price: 8000, units: 5 })).status).toBe(403);
    await Supplier.updateOne({ _id: supplier._id }, { $set: { verificationStatus: "VERIFIED" } });
    expect((await request(app).post(`/api/suppliers/me/products/${product._id}/publish`).set(as("warehouse")).send({ price: 8000, units: 5 })).status).toBe(403);
  });
});
