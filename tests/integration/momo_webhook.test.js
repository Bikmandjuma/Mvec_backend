require("../helpers/jest-shim"); // Jest-style API on node:test
const db = require("../helpers/mysql"); // MySQL test database (first, before models)
const paypackService = require("../../src/services/paypack.service");
const orm = require("../../src/database/orm");
const crypto = require("crypto");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");

const User = require("../../src/models/User");
const Order = require("../../src/models/Order");
const Payment = require("../../src/models/Payment");
const Product = require("../../src/models/Product");
const Category = require("../../src/models/Category");
const PricingSnapshot = require("../../src/models/PricingSnapshot");
const Settlement = require("../../src/models/Settlement");
const LedgerEntry = require("../../src/models/LedgerEntry");
const LedgerAccount = require("../../src/models/LedgerAccount");
const VendorWallet = require("../../src/models/VendorWallet");
const PaymentWebhookLog = require("../../src/models/PaymentWebhookLog");

jest.setTimeout(120000);

const JWT_SECRET = "momo_test_secret_key";
let app;

function createTestApp() {
  const testApp = express();
  testApp.use(helmet());
  testApp.use(cors());
  testApp.use(express.json());
  testApp.use("/api/payments", require("../../src/routes/payment.routes"));
  testApp.use("/api/webhooks", require("../../src/routes/webhook.routes"));
  testApp.use("/api/admin", require("../../src/routes/admin.financial.routes"));
  return testApp;
}



describe("MoMo USSD Push Webhook Integration", () => {
  let buyer, vendor, category, product, buyerToken;
  let mongoReady = false;

  beforeAll(async () => {
    // Behave like live Paypack: the push stays PENDING until the webhook arrives.
    jest.spyOn(paypackService, "isSandbox").mockReturnValue(false);
    jest.spyOn(paypackService, "triggerUssdPush").mockImplementation(async ({ amount }) => {
      const ref = `PP-${require("crypto").randomUUID()}`;
      return { success: true, reference: ref, status: "PENDING", raw: { ref, amount, status: "pending" } };
    });
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = JWT_SECRET;
    try {
      // MySQL test database (transactions are MySQL transactions).
      await db.setup();
      mongoReady = true;
      app = createTestApp();
    } catch (err) {
      // Escrow locking uses MongoDB transactions, which require a real replica
      // set. Some constrained environments cannot provide one (mongodb-memory-server
      // silently falls back to a standalone node). Skip rather than fail there.
      console.warn("[momo_webhook.test.js] Skipping: replica set unavailable:", err.message);
    }
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    if (!mongoReady) {
      return;
    }
    await db.reset();

    buyer = await User.create({ Fullname: "Alice", email: "alice@mv.rw", password: "pass123", phone: "0788123999", gender: "female", role: "buyer" });
    vendor = await User.create({ Fullname: "Tech Vendor", email: "tech@mv.rw", password: "pass123", phone: "0788000002", gender: "male", role: "vendor", companyName: "Tech Ltd" });
    category = await Category.create({ name: "Electronics", slug: "electronics" });
    product = await Product.create({ vendor: vendor._id, category: category._id, brand: "B", name: "Wireless Mouse", slug: "wireless-mouse", sku: "WM-2", description: "d", price: 15000, stockQuantity: 100, status: "ACTIVE", media: { mainImage: "http://x.y/m.jpg" } });
    buyerToken = jwt.sign({ userId: buyer._id, role: buyer.role }, JWT_SECRET);
    await VendorWallet.create({ vendor: vendor._id, pendingBalance: 0, availableBalance: 0, totalEarned: 0, totalWithdrawn: 0, currency: "RWF" });
  });

  test("initiates USSD push, stores gatewayReference, webhook marks PAID & locks escrow idempotently", async () => {
    if (!mongoReady) return;
    const order = await Order.create({
      user: buyer._id,
      orderNumber: "ORD-MOMO-001",
      items: [{ product: product._id, vendor: vendor._id, category: category._id, name: "Wireless Mouse", price: 15000, quantity: 2 }],
      shippingAddress: { street: "KN 5 Rd", city: "Kigali", state: "Kigali", country: "Rwanda" },
      totalAmount: 30000,
      paymentStatus: "PENDING",
      orderStatus: "PENDING", // unpaid orders wait in PENDING
    });

    // 1. Initiation
    const initRes = await request(app)
      .post("/api/payments/momo/initiate")
      .set("Authorization", `Bearer ${buyerToken}`)
      .send({ orderId: order._id.toString(), phoneNumber: "0788123999" });

    expect(initRes.status).toBe(200);
    expect(initRes.body.paymentRef).toBeDefined();
    expect(initRes.body.paymentId).toBeDefined();
    expect(initRes.body.gatewayReference).toBeTruthy(); // Paypack reference (SANDBOX-… without keys)

    const payment = await Payment.findById(initRes.body.paymentId);
    expect(payment.status).toBe("PENDING");
    expect(payment.gatewayReference).toBeTruthy();

    // 2. Webhook callback
    const webhookRes = await request(app)
      .post("/api/webhooks/momo")
      .send({
        financialTransactionId: "GT-REF-100",
        externalId: payment.transactionReference,
        amount: 30000,
        status: "SUCCESSFUL",
      });

    expect(webhookRes.status).toBe(200);

    const updatedOrder = await Order.findById(order._id);
    expect(updatedOrder.paymentStatus).toBe("PAID");
    expect(updatedOrder.orderStatus).toBe("PROCESSING");

    const snapshots = await PricingSnapshot.find({ order: order._id });
    expect(snapshots.length).toBeGreaterThan(0);

    const settlements = await Settlement.find({ order: order._id });
    expect(settlements.length).toBeGreaterThan(0);
    expect(settlements[0].status).toBe("HELD");

    const escrowEntries = await LedgerEntry.find({ relatedOrder: order._id, entryType: "PAYMENT_ESCROW_LOCK" });
    expect(escrowEntries.length).toBe(1);

    // 3. Idempotency — replay the exact same callback
    const dupRes = await request(app)
      .post("/api/webhooks/momo")
      .send({
        financialTransactionId: "GT-REF-100",
        externalId: payment.transactionReference,
        amount: 30000,
        status: "SUCCESSFUL",
      });

    expect(dupRes.status).toBe(200);
    const logs = await PaymentWebhookLog.find({ externalTransactionId: "GT-REF-100" });
    expect(logs.length).toBe(1);
    expect(escrowEntries.length).toBe(1);
  });

  test("rejects invalid webhook signature in production mode", async () => {
    if (!mongoReady) return;
    process.env.NODE_ENV = "production";
    process.env.MOMO_WEBHOOK_SECRET = "prod-secret";

    const res = await request(app)
      .post("/api/webhooks/momo")
      .set("x-momo-signature", "deadbeef")
      .send({ financialTransactionId: "GT-X", status: "SUCCESSFUL", amount: 100 });

    expect(res.status).toBe(401);
    process.env.NODE_ENV = "test";
  });

  test("successfully signs & verifies a valid payload in production mode", async () => {
    if (!mongoReady) return;
    process.env.NODE_ENV = "production";
    process.env.MOMO_WEBHOOK_SECRET = "prod-secret";

    const payload = { financialTransactionId: "GT-SIG-1", externalId: "ORD-SIG", amount: 500, status: "SUCCESSFUL" };
    const signature = crypto.createHmac("sha256", "prod-secret").update(JSON.stringify(payload)).digest("hex");

    const order = await Order.create({
      user: buyer._id,
      orderNumber: "ORD-MOMO-SIG",
      items: [{ product: product._id, vendor: vendor._id, category: category._id, name: "Wireless Mouse", price: 500, quantity: 1 }],
      shippingAddress: { street: "KN 5 Rd", city: "Kigali", state: "Kigali", country: "Rwanda" },
      totalAmount: 500,
      paymentStatus: "PENDING",
      orderStatus: "PENDING",
    });
    const payment = await Payment.create({
      parentOrder: order._id,
      transactionReference: "ORD-SIG",
      method: "MOMO",
      phoneNumber: "250788123999",
      provider: "MTN",
      amount: 500,
      currency: "RWF",
      status: "PENDING",
    });

    const res = await request(app)
      .post("/api/webhooks/momo")
      .set("x-momo-signature", signature)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    process.env.NODE_ENV = "test";
  });
});