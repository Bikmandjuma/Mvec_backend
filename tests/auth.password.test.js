const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
const User = require("../src/models/User");
const authController = require("../src/controllers/auth.controller");

// Helper to construct mock Express req & res
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

describe("Password Reset & Forgot Password Unit Tests", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.EMAIL_USER = "support@mvec.rw";
    process.env.EMAIL_PASS = "app-specific-password";
    process.env.FRONTEND_URL = "https://mvec.rw";
    process.env.JWT_SECRET = "test-jwt-secret";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ─── 1. ASSISTING FUNCTIONS & TRANSPORTER TESTS ─────────────────────────────
  describe("Assisting Functions: Transporter & Email Sending", () => {
    it("should create a valid nodemailer transporter when email credentials exist", () => {
      const transporter = authController.getTransporter();
      assert.ok(transporter, "Transporter should be created");
      assert.equal(typeof transporter.sendMail, "function", "Transporter should have sendMail method");
    });

    it("should throw a descriptive error when EMAIL_USER or EMAIL_PASS is missing", () => {
      delete process.env.EMAIL_USER;
      delete process.env.EMAIL_PASS;

      assert.throws(
        () => authController.getTransporter(),
        /Email credentials are not configured/
      );
    });

    it("should configure custom SMTP settings when EMAIL_HOST is provided", () => {
      process.env.EMAIL_HOST = "smtp.customhost.com";
      process.env.EMAIL_PORT = "465";
      process.env.EMAIL_SECURE = "true";

      const transporter = authController.getTransporter();
      assert.ok(transporter);
      assert.equal(transporter.options.host, "smtp.customhost.com");
      assert.equal(transporter.options.port, 465);
      assert.equal(transporter.options.secure, true);
    });

    it("should format email correctly and include reset token link in both text and HTML", async () => {
      let sentMailOptions = null;

      // Mock nodemailer transport
      const originalCreateTransport = nodemailer.createTransport;
      nodemailer.createTransport = () => ({
        sendMail: async (options) => {
          sentMailOptions = options;
          return { messageId: "mock-msg-123" };
        },
      });

      try {
        const testEmail = "buyer@example.com";
        const testUrl = "https://mvec.rw/reset-password/sample-random-token-12345";

        await authController.sendResetEmail(testEmail, testUrl);

        assert.ok(sentMailOptions, "sendMail should have been called");
        assert.equal(sentMailOptions.to, testEmail);
        assert.ok(sentMailOptions.from.includes("support@mvec.rw"));
        assert.equal(sentMailOptions.subject, "Password Reset Request");
        assert.ok(sentMailOptions.text.includes(testUrl), "Plaintext email should contain reset link");
        assert.ok(sentMailOptions.html.includes(testUrl), "HTML email should contain reset link");
        assert.ok(sentMailOptions.html.includes("sample-random-token-12345"), "HTML email should contain token");
      } finally {
        nodemailer.createTransport = originalCreateTransport;
      }
    });
  });

  // ─── 2. FORGOT PASSWORD CONTROLLER TESTS ───────────────────────────────────
  // ─── 2. CODE-BASED RESET (email or SMS) ──────────────────────────────────────
  // Flow: forgot-password sends a 6-digit code → verify-reset-otp returns a
  // one-time resetToken → reset-password sets the new password.
  // End-to-end coverage with a real database lives in tests/automation.test.js.
  const messaging = require("../src/services/messaging.service");
  const sha = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
  let originalFindOne, originalSendEmail, sentEmails;

  const makeUser = (overrides = {}) => ({
    _id: "u1",
    email: "buyer@mvec.rw",
    phone: "+250788123456",
    password: "hashed",
    resetPasswordAttempts: 0,
    saves: 0,
    async save() { this.saves += 1; return this; },
    ...overrides,
  });
  const mockFindOne = (user, { chained = true } = {}) => {
    User.findOne = () => (chained ? { select: async () => user } : Promise.resolve(user));
  };

  beforeEach(() => {
    originalFindOne = User.findOne;
    originalSendEmail = messaging.sendEmail;
    sentEmails = [];
    messaging.sendEmail = async (msg) => { sentEmails.push(msg); };
  });
  afterEach(() => {
    User.findOne = originalFindOne;
    messaging.sendEmail = originalSendEmail;
  });

  describe("Forgot password", () => {
    it("emails a 6-digit code and stores only its hash", async () => {
      const user = makeUser();
      mockFindOne(user);
      const { req, res } = createMockReqRes({ body: { email: "Buyer@MVEC.rw" } });
      await authController.forgotPassword(req, res);
      assert.equal(res.statusCode, 200);
      const code = sentEmails[0].text.match(/\d{6}/)[0];
      assert.equal(user.resetPasswordCode, sha(code));
      assert.ok(user.resetPasswordCodeExpires > new Date());
      assert.equal(res.jsonData.devCode, undefined, "codes sent by email are never returned");
    });

    it("answers the same way when no account exists", async () => {
      mockFindOne(null);
      const { req, res } = createMockReqRes({ body: { email: "nobody@mvec.rw" } });
      await authController.forgotPassword(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(sentEmails.length, 0);
    });

    it("rejects a request with no email or phone", async () => {
      const { req, res } = createMockReqRes({ body: {} });
      await authController.forgotPassword(req, res);
      assert.equal(res.statusCode, 400);
    });

    it("tells Google sign-in accounts to use Google", async () => {
      mockFindOne(makeUser({ password: undefined, googleId: "g-1" }));
      const { req, res } = createMockReqRes({ body: { email: "buyer@mvec.rw" } });
      await authController.forgotPassword(req, res);
      assert.equal(res.statusCode, 400);
    });

    it("clears the code and reports failure when the email cannot be sent", async () => {
      const user = makeUser();
      mockFindOne(user);
      messaging.sendEmail = async () => { throw new Error("SMTP down"); };
      const { req, res } = createMockReqRes({ body: { email: "buyer@mvec.rw" } });
      await authController.forgotPassword(req, res);
      assert.equal(res.statusCode, 502);
      assert.equal(user.resetPasswordCode, undefined);
    });
  });

  describe("Verify code", () => {
    it("counts wrong codes and returns a reset token for the right one", async () => {
      const user = makeUser({ resetPasswordCode: sha("123456"), resetPasswordCodeExpires: new Date(Date.now() + 60000) });
      mockFindOne(user);
      let r = createMockReqRes({ body: { email: "buyer@mvec.rw", code: "000000" } });
      await authController.verifyResetOtp(r.req, r.res);
      assert.equal(r.res.statusCode, 400);
      assert.equal(user.resetPasswordAttempts, 1);

      r = createMockReqRes({ body: { email: "buyer@mvec.rw", code: "123456" } });
      await authController.verifyResetOtp(r.req, r.res);
      assert.equal(r.res.statusCode, 200);
      assert.equal(user.resetPasswordToken, sha(r.res.jsonData.resetToken));
      assert.equal(user.resetPasswordCode, undefined, "a code works once");
    });

    it("refuses after 5 wrong codes and when the code expired", async () => {
      mockFindOne(makeUser({ resetPasswordCode: sha("123456"), resetPasswordCodeExpires: new Date(Date.now() + 60000), resetPasswordAttempts: 5 }));
      let r = createMockReqRes({ body: { email: "buyer@mvec.rw", code: "123456" } });
      await authController.verifyResetOtp(r.req, r.res);
      assert.equal(r.res.statusCode, 429);

      mockFindOne(makeUser({ resetPasswordCode: sha("123456"), resetPasswordCodeExpires: new Date(Date.now() - 1000) }));
      r = createMockReqRes({ body: { email: "buyer@mvec.rw", code: "123456" } });
      await authController.verifyResetOtp(r.req, r.res);
      assert.equal(r.res.statusCode, 400);
    });
  });

  describe("Reset password", () => {
    it("sets the new password, clears the token and signs out other sessions", async () => {
      const user = makeUser({ resetPasswordToken: sha("tok"), resetPasswordExpires: new Date(Date.now() + 60000) });
      mockFindOne(user, { chained: false });
      const { req, res } = createMockReqRes({ body: { resetToken: "tok", newPassword: "newpassword1" } });
      await authController.resetPassword(req, res);
      assert.equal(res.statusCode, 200);
      assert.ok(await bcrypt.compare("newpassword1", user.password));
      assert.equal(user.resetPasswordToken, undefined);
      assert.ok(user.lastPasswordChangeAt instanceof Date);
    });

    it("still accepts the token in the URL (older email links)", async () => {
      const user = makeUser({ resetPasswordToken: sha("tok") });
      mockFindOne(user, { chained: false });
      const { req, res } = createMockReqRes({ params: { token: "tok" }, body: { password: "newpassword1" } });
      await authController.resetPassword(req, res);
      assert.equal(res.statusCode, 200);
    });

    it("rejects an unknown or expired token and short passwords", async () => {
      mockFindOne(null, { chained: false });
      let r = createMockReqRes({ body: { resetToken: "nope", newPassword: "newpassword1" } });
      await authController.resetPassword(r.req, r.res);
      assert.equal(r.res.statusCode, 400);

      r = createMockReqRes({ body: { resetToken: "tok", newPassword: "short" } });
      await authController.resetPassword(r.req, r.res);
      assert.equal(r.res.statusCode, 400);
    });
  });
});
