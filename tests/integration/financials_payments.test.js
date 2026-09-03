const mongoose = require("mongoose");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const imported = require("../../server");

// Unwraps the Express app whether it's exported directly or nested inside an object
const app = imported.app || imported.default || imported;

const User = require("../../src/models/User");
const Order = require("../../src/models/Order");
const Payment = require("../../src/models/Payment");
const Settlement = require("../../src/models/Settlement");
const VendorWallet = require("../../src/models/VendorWallet");

const JWT_SECRET = process.env.JWT_SECRET || "test_secret_key";

describe("Financials & Payments Integration Suite", () => {
  let superAdminUser, vendorUser, buyerUser;
  let superAdminToken, vendorToken, buyerToken;
  let sampleOrder, samplePayment;

  beforeAll(async () => {
    // Ensure test environment is active to skip HMAC checks in webhook handlers
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = JWT_SECRET;
  });

  beforeEach(async () => {
    // Clean up database collections prior to seeding
    await User.deleteMany({});
    await Order.deleteMany({});
    await Payment.deleteMany({});
    await Settlement.deleteMany({});
    await VendorWallet.deleteMany({});

    // 1. Seed Users (Matching exact Schema Enums & Validations)
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

    // 2. Generate Auth Tokens
    superAdminToken = jwt.sign(
      { id: superAdminUser._id, role: superAdminUser.role },
      JWT_SECRET
    );
    vendorToken = jwt.sign(
      { id: vendorUser._id, role: vendorUser.role },
      JWT_SECRET
    );
    buyerToken = jwt.sign(
      { id: buyerUser._id, role: buyerUser.role },
      JWT_SECRET
    );

    // 3. Seed Vendor Wallet
    await VendorWallet.create({
      vendor: vendorUser._id,
      pendingBalance: 0,
      availableBalance: 0,
      totalEarned: 0,
      totalWithdrawn: 0,
      currency: "RWF",
    });

    // 4. Seed Sample Order
    sampleOrder = await Order.create({
      user: buyerUser._id,
      orderNumber: "ORD-2026-001",
      items: [
        {
          product: new mongoose.Types.ObjectId(),
          vendor: vendorUser._id,
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
        postalCode: "0000",
      },
      totalAmount: 30000,
      paymentStatus: "PENDING",
      orderStatus: "PROCESSING",
      paymentMethod: "MOMO",
    });

    // 5. Seed Sample Payment
    samplePayment = await Payment.create({
      parentOrder: sampleOrder._id,
      transactionReference: "TX-MOMO-998877",
      method: "MOMO",
      phoneNumber: "250788123456",
      provider: "MTN",
      status: "PENDING",
      amount: 30000,
      currency: "RWF",
    });
  });

  describe("1. Payment Initiation Tests", () => {
    test("Should successfully initiate MoMo payment when authenticated", async () => {
      const response = await request(app)
        .post("/api/payments/momo/initiate") // Adjust route prefix if different
        .set("Authorization", `Bearer ${buyerToken}`)
        .send({
          orderId: sampleOrder._id,
          phoneNumber: "0788123456",
        });

      // Validates response code
      expect([200, 201]).toContain(response.statusCode);
    });

    test("Should reject payment initiation for unauthenticated request", async () => {
      const response = await request(app)
        .post("/api/payments/momo/initiate")
        .send({
          orderId: sampleOrder._id,
          phoneNumber: "0788123456",
        });

      expect([401, 403]).toContain(response.statusCode);
    });
  });

  describe("2. Webhook Execution Tests", () => {
    test("Should receive and process MTN MoMo SUCCESSFUL webhook", async () => {
      const payload = {
        financialTransactionId: "FIN-123456",
        externalId: sampleOrder._id.toString(),
        amount: 30000,
        status: "SUCCESSFUL",
      };

      const response = await request(app)
        .post("/api/webhooks/momo")
        .send(payload);

      expect(response.statusCode).toBe(200);
      expect(response.body.success).toBe(true);
    });

    test("Should ignore MTN MoMo non-SUCCESSFUL webhooks gracefully", async () => {
      const payload = {
        financialTransactionId: "FIN-123456",
        externalId: sampleOrder._id.toString(),
        amount: 30000,
        status: "FAILED",
      };

      const response = await request(app)
        .post("/api/webhooks/momo")
        .send(payload);

      expect(response.statusCode).toBe(200);
      expect(response.body.message).toMatch(/Ignored/i);
    });
  });
});