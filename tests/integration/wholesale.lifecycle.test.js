require("../helpers/jest-shim"); // Jest-style API on node:test
const db = require("../helpers/mysql"); // MySQL test database (first, before models)
const request = require("supertest");
const jwt = require("jsonwebtoken");
const express = require("express");
const User = require("../../src/models/User");
const Vendor = require("../../src/models/Vendor");
const Supplier = require("../../src/models/Supplier");
const SupplierTeamMember = require("../../src/models/SupplierTeamMember");
const WholesaleProduct = require("../../src/models/WholesaleProduct");
const WholesaleOrder = require("../../src/models/WholesaleOrder");
const Settlement = require("../../src/models/Settlement");
const VendorWallet = require("../../src/models/VendorWallet");
const Disbursement = require("../../src/models/Disbursement");
const Notification = require("../../src/models/Notification");
const Category = require("../../src/models/Category");
const commission = require("../../src/services/commission.service");
const wholesale = require("../../src/services/wholesale.service");

jest.setTimeout(90000);

describe("Wholesale end to end: quotes, escrow, commission, cancel, disputes, deadlines, teams", () => {
  let app;
  let admin;
  let vendor;
  let supplierUser;
  let warehouse;
  let viewer;
  let buyer;
  let supplier;
  let product;
  const tokens = {};
  const secret = "wholesale_lifecycle_secret";

  beforeAll(async () => {
    process.env.JWT_SECRET = secret;
    delete process.env.PAYPACK_CLIENT_ID; // sandbox payments and transfers
    await db.setup();
    app = express();
    app.use(express.json());
    app.use("/api/wholesale", require("../../src/routes/wholesale.routes"));
    app.use("/api/quotes", require("../../src/routes/quote.routes"));
    app.use("/api/reports", require("../../src/routes/report.routes"));
    app.use("/api/disputes", require("../../src/routes/dispute.routes"));
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.reset();
    commission.clearCache();
    const make = (name, role, n, extra = {}) => User.create({ Fullname: name, companyName: name, email: `${role}${n}@example.com`, password: "password123", phone: `07880003${String(n).padStart(2, "0")}`, gender: "male", role, isOnboarded: true, ...extra });
    admin = await make("Ops Admin", "super_admin", 1);
    vendor = await make("Corner Shop", "vendor", 2);
    supplierUser = await make("Rice Supplier", "supplier", 3);
    warehouse = await make("Warehouse Worker", "supplier", 4);
    viewer = await make("Viewer Member", "supplier", 5);
    buyer = await make("Some Buyer", "buyer", 6);
    await Vendor.create({ user: vendor._id, businessName: "Corner Shop", phone: "0788000302", email: "vendor2@example.com", description: "A corner shop in Kigali.", logoUrl: "/l.png", category: "Food", location: "Kigali", verificationStatus: "VERIFIED" });
    supplier = await Supplier.create({ user: supplierUser._id, businessName: "Rice Supplier", phone: "0788000303", email: "supplier3@example.com", description: "Rice and beans in bulk.", logoUrl: "/l.png", category: "Food", location: "Kigali", verificationStatus: "VERIFIED", status: "ACTIVE" });
    await SupplierTeamMember.create({ supplier: supplier._id, user: warehouse._id, fullName: "Warehouse Worker", phone: "0788000304", role: "WAREHOUSE", status: "ACTIVE" });
    await SupplierTeamMember.create({ supplier: supplier._id, user: viewer._id, fullName: "Viewer Member", phone: "0788000305", role: "VIEWER", status: "ACTIVE" });
    await Category.create({ name: "Food", slug: "food" });
    product = await WholesaleProduct.create({ supplier: supplier._id, name: "Rice 25kg", category: "Food", unit: "bag", wholesalePrice: 30000, moq: 2, stockQuantity: 10, status: "ACTIVE" });
    for (const [k, u] of Object.entries({ admin, vendor, supplierUser, warehouse, viewer, buyer })) tokens[k] = jwt.sign({ userId: u._id }, secret);
  });

  const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
  const stock = async () => (await WholesaleProduct.findById(product._id)).stockQuantity;
  const order = async (qty = 2) => (await request(app).post("/api/wholesale/orders").set(as("vendor")).send({ supplierId: String(supplier._id), items: [{ productId: String(product._id), quantity: qty }] })).body.data;
  const pay = (id) => request(app).post(`/api/wholesale/orders/${id}/pay`).set(as("vendor")).send({ method: "momo", phoneNumber: "0788123456" });

  test("catalog order reserves stock; paying holds money with the wholesale commission; receipt pays the supplier net", async () => {
    await commission.updateSettings({ defaultWholesaleCommissionPercent: 2 });
    const o = await order(3);
    expect(await stock()).toBe(7);
    expect((await Notification.findOne({ recipient: supplierUser._id })).title).toMatch(/New wholesale order/);

    expect((await pay(o._id)).body.status).toBe("SUCCESS");
    const held = await Settlement.findOne({ order: o._id });
    expect(held.status).toBe("HELD");
    expect(held.commissionAmount).toBe(1800); // 2% of 90,000
    expect(held.netAmount).toBe(88200);

    // A warehouse team member ships; a viewer cannot.
    expect((await request(app).post(`/api/wholesale/orders/${o._id}/ship`).set(as("viewer"))).status).toBe(403);
    expect((await request(app).post(`/api/wholesale/orders/${o._id}/ship`).set(as("warehouse"))).status).toBe(200);
    const listed = await request(app).get("/api/wholesale/orders/mine").set(as("warehouse"));
    expect(listed.body.orders.length).toBe(1);

    const done = await request(app).post(`/api/wholesale/orders/${o._id}/confirm-receipt`).set(as("vendor"));
    expect(done.status).toBe(200);
    expect((await VendorWallet.findOne({ vendor: supplierUser._id })).availableBalance).toBe(88200);
    expect((await Settlement.findById(held._id)).status).toBe("RELEASED");
  });

  test("cancelling: unpaid gives the stock back; paid is refunded; suppliers must say why", async () => {
    const unpaid = await order(2);
    expect(await stock()).toBe(8);
    expect((await request(app).post(`/api/wholesale/orders/${unpaid._id}/cancel`).set(as("vendor"))).status).toBe(200);
    expect(await stock()).toBe(10);

    const paid = await order(2);
    await pay(paid._id);
    expect((await request(app).post(`/api/wholesale/orders/${paid._id}/cancel`).set(as("supplierUser")).send({})).status).toBe(400);
    const cancel = await request(app).post(`/api/wholesale/orders/${paid._id}/cancel`).set(as("supplierUser")).send({ reason: "The rice is damaged in our store." });
    expect(cancel.status).toBe(200);
    const refund = await Disbursement.findOne({ kind: "REFUND", order: paid._id });
    expect(refund.amount).toBe(60000);
    expect((await Settlement.findOne({ order: paid._id })).status).toBe("REFUNDED");
    const toldVendor = await Notification.findOne({ recipient: vendor._id, title: { $regex: "cancelled" } });
    expect(toldVendor.message).toMatch(/damaged/);
  });

  test("a reported problem holds the money until an admin decides", async () => {
    const o = await order(2);
    await pay(o._id);
    await request(app).post(`/api/wholesale/orders/${o._id}/ship`).set(as("supplierUser"));
    expect((await request(app).post(`/api/wholesale/orders/${o._id}/report-problem`).set(as("vendor")).send({ reason: "Half the bags are torn and wet." })).status).toBe(200);
    expect((await request(app).post(`/api/wholesale/orders/${o._id}/confirm-receipt`).set(as("vendor"))).status).toBe(409);
    const resolved = await request(app).post(`/api/wholesale/admin/orders/${o._id}/resolve`).set(as("admin")).send({ decision: "REFUND", note: "Photos confirm the damage." });
    expect(resolved.status).toBe(200);
    expect((await WholesaleOrder.findById(o._id)).status).toBe("CANCELLED");
    expect((await request(app).post(`/api/wholesale/admin/orders/${o._id}/resolve`).set(as("vendor")).send({ decision: "RELEASE" })).status).toBe(403);
  });

  test("deadlines: unpaid orders expire, shipped orders pay the supplier after 7 days", async () => {
    const unpaid = await order(2);
    const shipped = await order(2);
    await pay(shipped._id);
    await request(app).post(`/api/wholesale/orders/${shipped._id}/ship`).set(as("supplierUser"));
    const later = new Date(Date.now() + 8 * 24 * 3600 * 1000);
    const result = await wholesale.runAutomations(later);
    expect(result.expired).toBe(1);
    expect(result.released).toBe(1);
    expect((await WholesaleOrder.findById(unpaid._id)).status).toBe("CANCELLED");
    expect((await WholesaleOrder.findById(shipped._id)).status).toBe("CONFIRMED_RELEASED");
  });

  test("quote requests: vendor asks, supplier quotes, vendor accepts, it becomes an order to pay", async () => {
    const rfq = await request(app).post("/api/quotes/requests").set(as("vendor")).send({ category: "Food", neededBy: new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10), lines: [{ product: "Maize flour", units: 40, unit: "bag", targetPrice: 18000 }] });
    expect(rfq.status).toBe(201);
    expect((await Notification.findOne({ recipient: supplierUser._id, title: { $regex: "quote request" } }))).toBeTruthy();

    const open = await request(app).get("/api/quotes/open").set(as("supplierUser"));
    expect(open.body.requests[0].matchesMyCategory).toBe(true);
    const rid = open.body.requests[0].id;
    expect((await request(app).post(`/api/quotes/requests/${rid}/quotes`).set(as("viewer")).send({ lines: [{ unitPrice: 17500 }], deliveryDays: 2 })).status).toBe(403);
    const quote = await request(app).post(`/api/quotes/requests/${rid}/quotes`).set(as("supplierUser")).send({ lines: [{ unitPrice: 17500 }], deliveryDays: 2, note: "Delivered to your shop." });
    expect(quote.status).toBe(200);
    expect(quote.body.quote.totalAmount).toBe(700000);

    const mine = await request(app).get("/api/quotes/requests/mine").set(as("vendor"));
    const qid = mine.body.requests[0].quotes[0].id;
    expect((await request(app).post(`/api/quotes/${qid}/accept`).set(as("buyer"))).status).toBe(403);
    const accepted = await request(app).post(`/api/quotes/${qid}/accept`).set(as("vendor"));
    expect(accepted.status).toBe(200);
    expect(accepted.body.order.status).toBe("PENDING_PAYMENT");
    expect(accepted.body.order.totalAmount).toBe(700000);
    expect((await pay(accepted.body.order._id || accepted.body.order.id)).body.status).toBe("SUCCESS");
  });

  test("security: reports are for sellers and admins only; dispute evidence only for the parties", async () => {
    expect((await request(app).get("/api/reports/summary").set(as("buyer"))).status).toBe(403);
    expect((await request(app).get("/api/reports/summary").set(as("supplierUser"))).status).toBe(403);
    const Dispute = require("../../src/models/Dispute");
    const d = await Dispute.create({ disputeNumber: `DSP-${Date.now()}`, order: "6a0000000000000000000abc", raisedBy: vendor._id, vendor: supplierUser._id, reason: "OTHER", description: "Test dispute", disputedAmount: 1000 });
    const res = await request(app).post(`/api/disputes/${d._id}/evidence`).set(as("buyer")).send({ message: "I am not part of this" });
    expect(res.status).toBe(404);
  });
});
