const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const User = require("../src/models/User");
const Otp = require("../src/models/Otp");
const authController = require("../src/controllers/auth.controller");

function createMockReqRes(options = {}) {
  const req = {
    body: options.body || {},
    params: options.params || {},
    headers: options.headers || {},
    user: options.user || null,
  };

  const res = {
    statusCode: 200,
    jsonData: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.jsonData = data;
      return this;
    },
  };

  return { req, res };
}

const sha256 = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

describe("Phone OTP Unit Tests (send-otp / verify-otp)", () => {
  const originalEnv = { ...process.env };
  let originalCreate, originalFindOne, originalUpdateMany, originalUserFindOne;

  beforeEach(() => {
    process.env.JWT_SECRET = "test-jwt-secret";
    process.env.NODE_ENV = "development";
    process.env.OTP_EXPIRY_SECONDS = "300";
    process.env.OTP_COOLDOWN_SECONDS = "60";
    process.env.OTP_MAX_ATTEMPTS = "5";

    originalCreate = Otp.create;
    originalFindOne = Otp.findOne;
    originalUpdateMany = Otp.updateMany;
    originalUserFindOne = User.findOne;

    Otp.create = async (payload) => payload;
    Otp.findOne = async () => null;
    Otp.updateMany = async () => ({ modifiedCount: 0 });
    User.findOne = async () => null;
  });

  afterEach(() => {
    Otp.create = originalCreate;
    Otp.findOne = originalFindOne;
    Otp.updateMany = originalUpdateMany;
    User.findOne = originalUserFindOne;
    process.env = { ...originalEnv };
  });

  // ─── 1. SEND OTP ───────────────────────────────────────────────────────────
  describe("send-otp", () => {
    it("should reject an invalid purpose", async () => {
      const { req, res } = createMockReqRes({
        body: { phone: "0788123456", purpose: "banana" },
      });
      await authController.sendOtp(req, res);
      assert.equal(res.statusCode, 400);
      assert.match(res.jsonData.message, /purpose must be one of/);
    });

    it("should reject an invalid Rwandan phone number", async () => {
      const { req, res } = createMockReqRes({
        body: { phone: "12345", purpose: "login" },
      });
      await authController.sendOtp(req, res);
      assert.equal(res.statusCode, 400);
      assert.match(res.jsonData.message, /valid Rwandan phone number/);
    });

    it("should normalize the phone, store a hashed code and expose devCode in development", async () => {
      let capturedPayload = null;
      Otp.create = async (payload) => {
        capturedPayload = payload;
        return payload;
      };

      const { req, res } = createMockReqRes({
        body: { phone: "0788123456", purpose: "login" },
      });
      await authController.sendOtp(req, res);

      assert.equal(res.statusCode, 200);
      assert.ok(res.jsonData.devCode, "devCode must be present in development");
      assert.match(res.jsonData.devCode, /^\d{6}$/);

      assert.equal(capturedPayload.phone, "+250788123456");
      assert.equal(capturedPayload.purpose, "login");
      assert.equal(
        capturedPayload.codeHash,
        sha256(res.jsonData.devCode),
        "stored codeHash must equal sha256 of the delivered code",
      );
      assert.ok(capturedPayload.expiresAt > new Date());
      assert.equal(capturedPayload.attempts, 0);
      assert.equal(capturedPayload.consumed, false);
    });

    it("should respect the resend cooldown (429)", async () => {
      Otp.findOne = async () => ({
        lastSentAt: new Date(Date.now() - 10 * 1000), // 10s ago < 60s cooldown
      });

      const { req, res } = createMockReqRes({
        body: { phone: "0788123456", purpose: "login" },
      });
      await authController.sendOtp(req, res);

      assert.equal(res.statusCode, 429);
      assert.match(res.jsonData.message, /wait/);
    });

    it("should not return devCode outside of development", async () => {
      process.env.NODE_ENV = "production";
      const { req, res } = createMockReqRes({
        body: { phone: "0788123456", purpose: "login" },
      });
      await authController.sendOtp(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.jsonData.devCode, undefined);
    });
  });

  // ─── 2. VERIFY OTP ─────────────────────────────────────────────────────────
  const buildOtpDoc = (code, overrides = {}) => ({
    phone: "+250788123456",
    purpose: "login",
    codeHash: sha256(code),
    expiresAt: new Date(Date.now() + 300 * 1000),
    attempts: 0,
    consumed: false,
    save: async function () {
      return this;
    },
    ...overrides,
  });

  // verifyOtp does `Otp.findOne(...).sort(...)`, so mocks must be query-like.
  const mockFindOneSort = (doc) => ({ sort: async () => doc });

  describe("verify-otp", () => {
    it("should reject a non-6-digit code", async () => {
      const { req, res } = createMockReqRes({
        body: { phone: "0788123456", code: "12", purpose: "login" },
      });
      await authController.verifyOtp(req, res);
      assert.equal(res.statusCode, 400);
      assert.match(res.jsonData.message, /6-digit/);
    });

    it("should consume the code and return a verificationToken on registration", async () => {
      const code = "123456";
      Otp.findOne = () => mockFindOneSort(buildOtpDoc(code, { purpose: "registration" }));

      const { req, res } = createMockReqRes({
        body: { phone: "0788123456", code, purpose: "registration", role: "vendor" },
      });
      await authController.verifyOtp(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.jsonData.verified, true);
      assert.ok(res.jsonData.verificationToken, "registration must return a token");

      const decoded = jwt.verify(res.jsonData.verificationToken, process.env.JWT_SECRET);
      assert.equal(decoded.phone, "+250788123456");
      assert.equal(decoded.purpose, "registration");
      assert.equal(decoded.role, "vendor");
    });

    it("should sign in an existing user (passwordless) when purpose is login", async () => {
      const code = "654321";
      Otp.findOne = () => mockFindOneSort(buildOtpDoc(code));
      User.findOne = async () => ({
        _id: new (require("mongoose").Types.ObjectId)(),
        Fullname: "Alice",
        email: "alice@example.com",
        role: "buyer",
        phone: "+250788123456",
        gender: "female",
        companyName: null,
      });

      const { req, res } = createMockReqRes({
        body: { phone: "0788123456", code, purpose: "login" },
      });
      await authController.verifyOtp(req, res);

      assert.equal(res.statusCode, 200);
      assert.equal(res.jsonData.verified, true);
      assert.ok(res.jsonData.token, "passwordless login must return a JWT");
      assert.equal(res.jsonData.user.email, "alice@example.com");
    });

    it("should 404 when purpose is login but no account exists for the phone", async () => {
      const code = "111111";
      Otp.findOne = () => mockFindOneSort(buildOtpDoc(code));
      User.findOne = async () => null;

      const { req, res } = createMockReqRes({
        body: { phone: "0788123456", code, purpose: "login" },
      });
      await authController.verifyOtp(req, res);

      assert.equal(res.statusCode, 404);
      assert.match(res.jsonData.message, /No account is linked/);
    });

    it("should increment attempts on a wrong code and lock after max attempts", async () => {
      const code = "999999";
      const doc = buildOtpDoc("000000", { attempts: 4 }); // codeHash mismatch
      Otp.findOne = () => mockFindOneSort(doc);

      const { req, res } = createMockReqRes({
        body: { phone: "0788123456", code, purpose: "login" },
      });
      await authController.verifyOtp(req, res);

      assert.equal(res.statusCode, 429);
      assert.match(res.jsonData.message, /Too many failed attempts/);
      assert.equal(doc.consumed, true, "code must be locked once attempts are exhausted");

      // A non-exhausted wrong attempt should return 400 and increment attempts
      const doc2 = buildOtpDoc("000000", { attempts: 1 });
      Otp.findOne = () => mockFindOneSort(doc2);
      const { req: req2, res: res2 } = createMockReqRes({
        body: { phone: "0788123456", code, purpose: "login" },
      });
      await authController.verifyOtp(req2, res2);

      assert.equal(res2.statusCode, 400);
      assert.equal(doc2.attempts, 2);
      assert.equal(doc2.consumed, false);
    });

    it("should reject expired codes", async () => {
      const code = "123456";
      // An expired code is filtered out by the DB query (expiresAt: {$gt: now}),
      // so the controller sees no active record.
      Otp.findOne = () => mockFindOneSort(null);

      const { req, res } = createMockReqRes({
        body: { phone: "0788123456", code, purpose: "login" },
      });
      await authController.verifyOtp(req, res);

      assert.equal(res.statusCode, 400);
      assert.match(res.jsonData.message, /Invalid or expired/);
    });
  });

  // ─── 3. REGISTER WITH VERIFICATION TOKEN ───────────────────────────────────
  describe("registerUser with verificationToken", () => {
    let originalPrototypeSave;

    it("should reject an invalid/expired verification token", async () => {
      const { req, res } = createMockReqRes({
        body: {
          Fullname: "Bob",
          password: "secret123",
          gender: "male",
          role: "buyer",
          verificationToken: "garbage-token",
        },
      });
      await authController.registerUser(req, res);
      assert.equal(res.statusCode, 400);
      assert.match(res.jsonData.message, /Invalid or expired phone verification/);
    });

    it("should create a user when the phone has been OTP-verified", async () => {
      const verifiedPhone = "+250788123456";
      const token = jwt.sign(
        { phone: verifiedPhone, purpose: "registration", role: "buyer" },
        process.env.JWT_SECRET,
        { expiresIn: "15m" },
      );

      let savedDoc = null;
      originalPrototypeSave = User.prototype.save;
      User.prototype.save = async function () {
        savedDoc = this;
        this._id = new (require("mongoose").Types.ObjectId)();
        return this;
      };

      try {
        const { req, res } = createMockReqRes({
          body: {
            Fullname: "Bob",
            password: "secret123",
            gender: "male",
            role: "buyer",
            verificationToken: token,
          },
        });
        await authController.registerUser(req, res);

        assert.equal(res.statusCode, 201);
        assert.ok(res.jsonData.token);
        assert.equal(res.jsonData.user.Fullname, "Bob");
        assert.equal(savedDoc.phone, "+250788123456");
        assert.equal(savedDoc.email, undefined);
      } finally {
        User.prototype.save = originalPrototypeSave;
      }
    });

    it("should 400 when the phone in the body conflicts with the verified phone", async () => {
      const verifiedPhone = "+250788123456";
      const token = jwt.sign(
        { phone: verifiedPhone, purpose: "registration", role: "buyer" },
        process.env.JWT_SECRET,
        { expiresIn: "15m" },
      );

      const { req, res } = createMockReqRes({
        body: {
          Fullname: "Bob",
          password: "secret123",
          gender: "male",
          role: "buyer",
          phone: "0788999999",
          verificationToken: token,
        },
      });
      await authController.registerUser(req, res);
      assert.equal(res.statusCode, 400);
      assert.match(res.jsonData.message, /does not match the verified phone/);
    });
  });
});