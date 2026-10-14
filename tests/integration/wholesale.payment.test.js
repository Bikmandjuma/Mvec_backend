require("../helpers/jest-shim"); // Jest-style API on node:test
const db = require("../helpers/mysql"); // MySQL test database (first, before models)
const request = require("supertest");
const jwt = require("jsonwebtoken");
const express = require("express");
const User = require("../../src/models/User");
const WholesaleOrder = require("../../src/models/WholesaleOrder");
const Notification = require("../../src/models/Notification");

jest.setTimeout(60000);

describe("Wholesale orders are paid for real, and accounts can be blocked at once", () => {
  let app;
  let vendor;
  let otherVendor;
  let supplier;
  let admin;
  let order;
  const tokens = {};
  const secret = "wholesale_payment_test_secret";

  beforeAll(async () => {
    process.env.JWT_SECRET = secret;
    delete process.env.PAYPACK_CLIENT_ID; // sandbox: payments succeed at once
    await db.setup();
    app = express();
    app.use(express.json());
    app.use("/api/wholesale", require("../../src/routes/wholesale.routes"));
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.reset();
    const make = (name, role, n) => User.create({ Fullname: name, companyName: name, email: `${role}${n}@example.com`, password: "password123", phone: `07880000${20 + n}`, gender: "male", role, isOnboarded: true });
    vendor = await make("Shop One", "vendor", 1);
    otherVendor = await make("Shop Two", "vendor", 2);
    supplier = await make("Bulk Supplier", "supplier", 3);
    admin = await make("Ops Admin", "super_admin", 4);
    for (const [k, u] of Object.entries({ vendor, otherVendor, supplier, admin })) tokens[k] = jwt.sign({ userId: u._id }, secret);
    order = await WholesaleOrder.create({
      orderNumber: `WHL-${Date.now()}`, vendor: vendor._id, supplier: supplier._id, totalAmount: 60000, status: "PENDING_PAYMENT",
      items: [{ product: "6a0000000000000000009999", productName: "Rice 25kg", unitPrice: 30000, quantity: 2, moq: 1 }],
    });
  });

  const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });

  test("nobody can mark an order paid without paying; only an admin can do it by hand", async () => {
    for (const who of ["vendor", "otherVendor", "supplier"]) {
      const res = await request(app).post(`/api/wholesale/orders/${order._id}/hold-escrow`).set(as(who));
      expect(res.status).toBe(403);
    }
    expect((await WholesaleOrder.findById(order._id)).status).toBe("PENDING_PAYMENT");
    const manual = await request(app).post(`/api/wholesale/orders/${order._id}/hold-escrow`).set(as("admin"));
    expect(manual.status).toBe(200);
  });

  test("only the vendor who placed the order can pay it", async () => {
    const res = await request(app).post(`/api/wholesale/orders/${order._id}/pay`).set(as("otherVendor")).send({ method: "momo", phoneNumber: "0788123456" });
    expect(res.status).toBe(404);
  });

  test("paying holds the money in escrow and tells the supplier to ship", async () => {
    const res = await request(app).post(`/api/wholesale/orders/${order._id}/pay`).set(as("vendor")).send({ method: "momo", phoneNumber: "0788123456" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("SUCCESS");
    expect((await WholesaleOrder.findById(order._id)).status).toBe("ESCROW_HELD");
    const told = await Notification.findOne({ recipient: supplier._id });
    expect(told.title).toMatch(/is paid/);
    const again = await request(app).post(`/api/wholesale/orders/${order._id}/pay`).set(as("vendor")).send({ method: "momo", phoneNumber: "0788123456" });
    expect(again.status).toBe(409);
  });

  test("a blocked account loses access immediately, even with a valid token", async () => {
    await User.findByIdAndUpdate(vendor._id, { status: "BLOCK" });
    const res = await request(app).get("/api/wholesale/orders/mine").set(as("vendor"));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ACCOUNT_BLOCKED");
  });
});
