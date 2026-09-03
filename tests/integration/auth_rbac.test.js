const mongoose = require("mongoose");
const request = require("supertest");
const jwt = require("jsonwebtoken");

// Import Express app instance
const importedApp = require("../../server");
const app = importedApp.app || importedApp.default || importedApp;

const User = require("../../src/models/User");

const JWT_SECRET = process.env.JWT_SECRET || "test_secret_key";

describe("Step 5: Authentication & Authorization (RBAC) Suite", () => {
  let buyerUser, vendorUser, superAdminUser;
  let buyerToken, vendorToken, superAdminToken, expiredToken;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    process.env.JWT_SECRET = JWT_SECRET;
  });

  beforeEach(async () => {
    await User.deleteMany({});

    // 1. Seed Users for each Role (Matching User Schema Constraints)
    buyerUser = await User.create({
      Fullname: "Jean Paul",
      email: "buyer@gmail.com",
      password: "password123",
      phone: "0788123456",
      gender: "male",
      role: "buyer",
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

    superAdminUser = await User.create({
      Fullname: "Super Admin",
      email: "admin@mvec.rw",
      password: "password123",
      phone: "0788000001",
      gender: "male",
      role: "super_admin",
    });

    // 2. Generate Valid JWT Tokens
    buyerToken = jwt.sign(
      { id: buyerUser._id, role: buyerUser.role },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    vendorToken = jwt.sign(
      { id: vendorUser._id, role: vendorUser.role },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    superAdminToken = jwt.sign(
      { id: superAdminUser._id, role: superAdminUser.role },
      JWT_SECRET,
      { expiresIn: "1h" }
    );

    // 3. Generate Expired JWT Token
    expiredToken = jwt.sign(
      { id: buyerUser._id, role: buyerUser.role },
      JWT_SECRET,
      { expiresIn: "-1s" }
    );
  });

  describe("1. Authentication Middleware Checks (401 Unauthorized)", () => {
    test("Should reject request when Authorization header is completely missing", async () => {
      const res = await request(app)
        .post("/api/payments/momo/initiate")
        .send({ amount: 1000 });

      expect(res.statusCode).toBe(401);
    });

    test("Should reject request when token is malformed or invalid", async () => {
      const res = await request(app)
        .post("/api/payments/momo/initiate")
        .set("Authorization", "Bearer invalid_token_xyz")
        .send({ amount: 1000 });

      expect(res.statusCode).toBe(401);
    });

    test("Should reject request when token is expired", async () => {
      const res = await request(app)
        .post("/api/payments/momo/initiate")
        .set("Authorization", `Bearer ${expiredToken}`)
        .send({ amount: 1000 });

      expect(res.statusCode).toBe(401);
    });

    test("Should reject request signed with an incorrect secret key", async () => {
      const untrustedToken = jwt.sign(
        { id: buyerUser._id, role: buyerUser.role },
        "wrong_secret_key"
      );

      const res = await request(app)
        .post("/api/payments/momo/initiate")
        .set("Authorization", `Bearer ${untrustedToken}`)
        .send({ amount: 1000 });

      expect(res.statusCode).toBe(401);
    });
  });

  describe("2. Role-Based Access Control / RBAC Checks (403 Forbidden vs 200 OK)", () => {
    test("Should deny 'buyer' access to vendor-protected route (403 Forbidden)", async () => {
      const res = await request(app)
        .get("/api/vendor/wallet") // Vendor-only endpoint
        .set("Authorization", `Bearer ${buyerToken}`);

      expect([403, 401]).toContain(res.statusCode);
    });

    test("Should deny 'vendor' access to super_admin financial release route (403 Forbidden)", async () => {
      const res = await request(app)
        .post("/api/admin/settlements/release-all") // Super admin-only endpoint
        .set("Authorization", `Bearer ${vendorToken}`);

      expect([403, 401]).toContain(res.statusCode);
    });

    test("Should allow 'vendor' to access their own vendor dashboard route", async () => {
      const res = await request(app)
        .get("/api/vendor/wallet")
        .set("Authorization", `Bearer ${vendorToken}`);

      // Expect successful or standard route resolution (not 401/403 auth block)
      expect([200, 404]).toContain(res.statusCode);
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
    });

    test("Should allow 'super_admin' to access elevated system routes", async () => {
      const res = await request(app)
        .get("/api/admin/settlements")
        .set("Authorization", `Bearer ${superAdminToken}`);

      expect([200, 404]).toContain(res.statusCode);
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);
    });
  });
});