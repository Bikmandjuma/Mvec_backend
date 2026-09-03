const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
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
const CommissionRule = require("../../src/models/CommissionRule");

jest.setTimeout(60000);

let mongoServer;
let app;
const JWT_SECRET = "test_integration_secret_key";

function createTestApp() {
  const testApp = express();
  testApp.use(helmet());
  testApp.use(cors());
  testApp.use(express.json());

  testApp.use("/api/auth", require("../../src/routes/auth.routes"));
  testApp.use("/api/products", require("../../src/routes/product.routes"));
  testApp.use("/api/cart", require("../../src/routes/cart.routes"));
  testApp.use("/api/orders", require("../../src/routes/order.routes"));
  testApp.use("/api/stores", require("../../src/routes/store.routes"));
  testApp.use("/api/payouts", require("../../src/routes/payout.routes"));
  testApp.use("/api/staff", require("../../src/routes/staff.routes"));
  testApp.use("/api/payments", require("../../src/routes/payment.routes"));
  testApp.use("/api/admin", require("../../src/routes/admin.financial.routes"));
  testApp.use("/api/admin", require("../../src/routes/admin.commission.routes"));

  return testApp;
}

describe("Financials & Payments Integration Suite", () => {
  let superAdminUser, vendorUser, buyerUser;
  let superAdminToken, vendorToken, buyerToken;
  let electronicsCategory, sampleProduct;

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
    await Order.deleteMany({});
    await Payment.deleteMany({});
    await Product.deleteMany({});
    await Category.deleteMany({});
    await PricingSnapshot.deleteMany({});
    await Settlement.deleteMany({});
    await LedgerEntry.deleteMany({});
    await LedgerAccount.deleteMany({});
    await VendorWallet.deleteMany({});
    await PaymentWebhookLog.deleteMany({});
    await CommissionRule.deleteMany({});

    superAdminUser = await User.create({
      Fullname: "Super Admin",
      email: "admin@mvec.rw",
      password: "password123",
      phone: "0788000001",
      gender: "male",
      role: "super_admin",
    });

    vendorUser = await User.create({
      Fullname: "Kigali Electronics Vendor",
      email: "vendor@kigali.rw",
      password: "password123",
      phone: "0788000002",
      gender: "female",
      role: "vendor",
      companyName: "Kigali Tech Ltd",
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

    electronicsCategory = await Category.create({
      name: "Electronics",
      slug: "electronics",
    });

    sampleProduct = await Product.create({
      vendor: vendorUser._id,
      category: electronicsCategory._id,
      brand: "TechBrand",
      name: "Wireless Mouse",
      slug: "wireless-mouse",
      sku: "WM-001",
      description: "A wireless mouse",
      price: 15000,
      stockQuantity: 100,
      status: "ACTIVE",
      media: { mainImage: "http://example.com/mouse.jpg" },
    });

    await VendorWallet.create({
      vendor: vendorUser._id,
      pendingBalance: 0,
      availableBalance: 0,
      totalEarned: 0,
      totalWithdrawn: 0,
      currency: "RWF",
    });
  });

  describe("1. Payment Initiation Test", () => {
    test("Should initiate MoMo payment and create PENDING Payment record", async () => {
      const order = await Order.create({
        user: buyerUser._id,
        orderNumber: "ORD-TEST-001",
        items: [
          {
            product: sampleProduct._id,
            vendor: vendorUser._id,
            category: electronicsCategory._id,
            name: "Wireless Mouse",
            price: 15000,
            quantity: 2,
          },
        ],
        shippingAddress: {
          street: "KN 5 Rd",
          city: "Kigali",
          state: "Kigali",
          country: "Rwanda",
        },
        totalAmount: 30000,
        paymentStatus: "PENDING",
        orderStatus: "PROCESSING",
      });

      const response = await request(app)
        .post("/api/payments/momo/initiate")
        .set("Authorization", `Bearer ${buyerToken}`)
        .send({
          orderId: order._id.toString(),
          phoneNumber: "0788123456",
        });

      expect(response.status).toBe(200);
      expect(response.body.paymentRef).toBeDefined();
      expect(response.body.paymentId).toBeDefined();

      const payment = await Payment.findById(response.body.paymentId);
      expect(payment).toBeTruthy();
      expect(payment.status).toBe("PENDING");
      expect(payment.provider).toBe("MTN");
      expect(payment.amount).toBe(30000);
    });
  });

  describe("2. Webhook Execution & Idempotency Test", () => {
    test("Should process webhook, update order state, and reject duplicates", async () => {
      const order = await Order.create({
        user: buyerUser._id,
        orderNumber: "ORD-TEST-002",
        items: [
          {
            product: sampleProduct._id,
            vendor: vendorUser._id,
            category: electronicsCategory._id,
            name: "Wireless Mouse",
            price: 15000,
            quantity: 2,
          },
        ],
        shippingAddress: {
          street: "KN 5 Rd",
          city: "Kigali",
          state: "Kigali",
          country: "Rwanda",
        },
        totalAmount: 30000,
        paymentStatus: "PENDING",
        orderStatus: "PROCESSING",
      });

      const initResponse = await request(app)
        .post("/api/payments/momo/initiate")
        .set("Authorization", `Bearer ${buyerToken}`)
        .send({
          orderId: order._id.toString(),
          phoneNumber: "0788123456",
        });

      const paymentRef = initResponse.body.paymentRef;

      const webhookPayload = {
        event: "charge.success",
        reference: paymentRef,
        amount: 30000,
      };

      const webhookResponse = await request(app)
        .post("/api/payments/webhook")
        .send(webhookPayload);

      expect(webhookResponse.status).toBe(200);
      expect(webhookResponse.body.status).toBe("success");

      const updatedOrder = await Order.findById(order._id);
      expect(updatedOrder.paymentStatus).toBe("PAID");
      expect(updatedOrder.orderStatus).toBe("PROCESSING");

      const snapshots = await PricingSnapshot.find({ order: order._id });
      expect(snapshots.length).toBeGreaterThan(0);

      const settlements = await Settlement.find({ order: order._id });
      expect(settlements.length).toBeGreaterThan(0);
      expect(settlements[0].status).toBe("HELD");

      const duplicateResponse = await request(app)
        .post("/api/payments/webhook")
        .send(webhookPayload);

      expect(duplicateResponse.status).toBe(200);
      expect(duplicateResponse.body.message).toBe("Already processed");

      const ledgerEntries = await LedgerEntry.find({ relatedOrder: order._id });
      expect(ledgerEntries.length).toBe(1);

      const webhookLogs = await PaymentWebhookLog.find({
        externalTransactionId: paymentRef,
      });
      expect(webhookLogs.length).toBe(1);
    });
  });

  describe("3. Dynamic Commission Rule Evaluation Test", () => {
    test("Should apply 15% commission rule and compute correct financial split", async () => {
      const commissionResponse = await request(app)
        .post("/api/admin/commissions")
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send({
          name: "Electronics Commission",
          ruleType: "CATEGORY",
          targetCategory: electronicsCategory._id.toString(),
          rateType: "PERCENTAGE",
          rateValue: 15,
          priority: 1,
        });

      expect(commissionResponse.status).toBe(201);

      const order = await Order.create({
        user: buyerUser._id,
        orderNumber: "ORD-TEST-003",
        items: [
          {
            product: sampleProduct._id,
            vendor: vendorUser._id,
            category: electronicsCategory._id,
            name: "Wireless Mouse",
            price: 10000,
            quantity: 1,
          },
        ],
        shippingAddress: {
          street: "KN 5 Rd",
          city: "Kigali",
          state: "Kigali",
          country: "Rwanda",
        },
        totalAmount: 10000,
        paymentStatus: "PENDING",
        orderStatus: "PROCESSING",
      });

      const initResponse = await request(app)
        .post("/api/payments/momo/initiate")
        .set("Authorization", `Bearer ${buyerToken}`)
        .send({
          orderId: order._id.toString(),
          phoneNumber: "0788123456",
        });

      const paymentRef = initResponse.body.paymentRef;

      await request(app)
        .post("/api/payments/webhook")
        .send({
          event: "charge.success",
          reference: paymentRef,
          amount: 10000,
        });

      const snapshot = await PricingSnapshot.findOne({ order: order._id });
      expect(snapshot).toBeTruthy();
      expect(snapshot.commissionAmount).toBe(1500);
      expect(snapshot.vendorNetEarnings).toBe(8500);

      const wallet = await VendorWallet.findOne({ vendor: vendorUser._id });
      expect(wallet.pendingBalance).toBe(8500);

      const ledgerEntry = await LedgerEntry.findOne({
        relatedOrder: order._id,
        entryType: "PAYMENT_ESCROW_LOCK",
      });
      expect(ledgerEntry).toBeTruthy();
      expect(ledgerEntry.amount).toBe(10000);
    });
  });

  describe("4. Admin Settlement Hold Override Test", () => {
    test("Should place admin hold and block payout release", async () => {
      const order = await Order.create({
        user: buyerUser._id,
        orderNumber: "ORD-TEST-004",
        items: [
          {
            product: sampleProduct._id,
            vendor: vendorUser._id,
            category: electronicsCategory._id,
            name: "Wireless Mouse",
            price: 15000,
            quantity: 2,
          },
        ],
        shippingAddress: {
          street: "KN 5 Rd",
          city: "Kigali",
          state: "Kigali",
          country: "Rwanda",
        },
        totalAmount: 30000,
        paymentStatus: "PENDING",
        orderStatus: "PROCESSING",
      });

      const initResponse = await request(app)
        .post("/api/payments/momo/initiate")
        .set("Authorization", `Bearer ${buyerToken}`)
        .send({
          orderId: order._id.toString(),
          phoneNumber: "0788123456",
        });

      const paymentRef = initResponse.body.paymentRef;

      await request(app)
        .post("/api/payments/webhook")
        .send({
          event: "charge.success",
          reference: paymentRef,
          amount: 30000,
        });

      const settlement = await Settlement.findOne({ order: order._id });
      expect(settlement).toBeTruthy();
      expect(settlement.status).toBe("HELD");

      const holdResponse = await request(app)
        .patch(`/api/admin/settlements/${settlement._id}/hold`)
        .set("Authorization", `Bearer ${superAdminToken}`)
        .send({ reason: "Investigating fraud" });

      expect(holdResponse.status).toBe(200);

      const heldSettlement = await Settlement.findById(settlement._id);
      expect(heldSettlement.status).toBe("ADMIN_HOLD");

      const releaseResponse = await request(app)
        .post(`/api/admin/settlements/${settlement._id}/release`)
        .set("Authorization", `Bearer ${superAdminToken}`);

      expect(releaseResponse.status).toBe(400);
    });
  });
});
