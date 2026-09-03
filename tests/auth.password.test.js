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
  describe("Forgot Password Feature", () => {
    it("should successfully generate token, save hashed token to DB, and send email with token", async () => {
      let sentMailOptions = null;

      // Mock nodemailer
      const originalCreateTransport = nodemailer.createTransport;
      nodemailer.createTransport = () => ({
        sendMail: async (options) => {
          sentMailOptions = options;
          return { messageId: "mock-123" };
        },
      });

      // Mock user document
      const mockUser = {
        Fullname: "John Doe",
        email: "john@example.com",
        password: "hashed_existing_password",
        resetPasswordToken: undefined,
        resetPasswordExpires: undefined,
        save: async function () {
          return this;
        },
      };

      const originalFindOne = User.findOne;
      User.findOne = async ({ email }) => {
        if (email === "john@example.com") return mockUser;
        return null;
      };

      try {
        const { req, res } = createMockReqRes({
          body: { email: "  John@Example.Com  " }, // Test trim & lowercase normalization
        });

        await authController.forgotPassword(req, res);

        // 1. Verify HTTP response
        assert.equal(res.statusCode, 200);
        assert.equal(
          res.jsonData.message,
          "If an account exists with that email, a reset link has been sent."
        );

        // 2. Verify token was hashed and stored on user
        assert.ok(mockUser.resetPasswordToken, "User resetPasswordToken must be set in DB");
        assert.equal(mockUser.resetPasswordToken.length, 64, "SHA-256 hash length must be 64 hex characters");
        assert.ok(mockUser.resetPasswordExpires instanceof Date, "Expires must be a valid Date");
        assert.ok(mockUser.resetPasswordExpires.getTime() > Date.now(), "Expires must be in the future");

        // 3. Verify email was received with the token
        assert.ok(sentMailOptions, "Email should have been sent");
        assert.equal(sentMailOptions.to, "john@example.com");
        
        // Extract raw token from reset link in email
        const tokenMatch = sentMailOptions.text.match(/\/reset-password\/([a-f0-9]{64})/);
        assert.ok(tokenMatch, "Email link must contain a 64-character hex token");
        const rawTokenFromEmail = tokenMatch[1];

        // Verify SHA-256 hash of raw token matches the DB record
        const expectedHash = crypto.createHash("sha256").update(rawTokenFromEmail).digest("hex");
        assert.equal(expectedHash, mockUser.resetPasswordToken, "Token in email must hash to value in DB");
      } finally {
        nodemailer.createTransport = originalCreateTransport;
        User.findOne = originalFindOne;
      }
    });

    it("should return generic 200 message when user email does not exist (prevents enumeration)", async () => {
      const originalFindOne = User.findOne;
      User.findOne = async () => null;

      try {
        const { req, res } = createMockReqRes({
          body: { email: "nonexistent@example.com" },
        });

        await authController.forgotPassword(req, res);

        assert.equal(res.statusCode, 200);
        assert.equal(
          res.jsonData.message,
          "If an account exists with that email, a reset link has been sent."
        );
      } finally {
        User.findOne = originalFindOne;
      }
    });

    it("should reject empty or missing email with 400 Bad Request", async () => {
      const { req, res } = createMockReqRes({ body: {} });
      await authController.forgotPassword(req, res);

      assert.equal(res.statusCode, 400);
      assert.equal(res.jsonData.message, "Email is required");
    });

    it("should block Google OAuth users without password from password reset", async () => {
      const originalFindOne = User.findOne;
      User.findOne = async () => ({
        email: "googleuser@example.com",
        googleId: "google-123456",
        password: null,
      });

      try {
        const { req, res } = createMockReqRes({
          body: { email: "googleuser@example.com" },
        });

        await authController.forgotPassword(req, res);

        assert.equal(res.statusCode, 400);
        assert.ok(res.jsonData.message.includes("Google Sign-In"));
      } finally {
        User.findOne = originalFindOne;
      }
    });

    it("should safely rollback DB fields and return 500 if sending email fails", async () => {
      const originalCreateTransport = nodemailer.createTransport;
      nodemailer.createTransport = () => ({
        sendMail: async () => {
          throw new Error("SMTP connection refused");
        },
      });

      const mockUser = {
        email: "john@example.com",
        password: "hashed_password",
        resetPasswordToken: undefined,
        resetPasswordExpires: undefined,
        save: async function () {
          return this;
        },
      };

      const originalFindOne = User.findOne;
      User.findOne = async () => mockUser;

      try {
        const { req, res } = createMockReqRes({
          body: { email: "john@example.com" },
        });

        await authController.forgotPassword(req, res);

        assert.equal(res.statusCode, 500);
        assert.equal(res.jsonData.message, "Could not send reset email. Please try again later.");
        // Token must be wiped on failure
        assert.equal(mockUser.resetPasswordToken, undefined);
        assert.equal(mockUser.resetPasswordExpires, undefined);
      } finally {
        nodemailer.createTransport = originalCreateTransport;
        User.findOne = originalFindOne;
      }
    });
  });

  // ─── 3. RESET PASSWORD CONTROLLER TESTS ─────────────────────────────────────
  describe("Reset Password Feature", () => {
    it("should successfully reset password with valid token and new password", async () => {
      const rawToken = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
      const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");

      const mockUser = {
        Fullname: "Jane Doe",
        email: "jane@example.com",
        password: "old_hashed_password",
        resetPasswordToken: hashedToken,
        resetPasswordExpires: new Date(Date.now() + 10 * 60 * 1000), // Valid for 10 mins
        save: async function () {
          return this;
        },
      };

      const originalFindOne = User.findOne;
      User.findOne = async (query) => {
        if (
          query.resetPasswordToken === hashedToken &&
          query.resetPasswordExpires &&
          query.resetPasswordExpires.$gt < mockUser.resetPasswordExpires.getTime()
        ) {
          return mockUser;
        }
        return null;
      };

      try {
        const newPassword = "BrandNewSecretPassword123!";
        const { req, res } = createMockReqRes({
          params: { token: rawToken },
          body: { newPassword },
        });

        await authController.resetPassword(req, res);

        assert.equal(res.statusCode, 200);
        assert.ok(res.jsonData.message.includes("Password reset successful"));

        // Verify token fields are cleared
        assert.equal(mockUser.resetPasswordToken, undefined);
        assert.equal(mockUser.resetPasswordExpires, undefined);

        // Verify new password is a valid bcrypt hash
        const isMatch = await bcrypt.compare(newPassword, mockUser.password);
        assert.equal(isMatch, true, "New password must match the hashed password in DB");
      } finally {
        User.findOne = originalFindOne;
      }
    });

    it("should accept 'password' field in req.body for Swagger and frontend compatibility", async () => {
      const rawToken = "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff";
      const hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");

      const mockUser = {
        password: "old_password",
        resetPasswordToken: hashedToken,
        resetPasswordExpires: new Date(Date.now() + 10 * 60 * 1000),
        save: async function () {
          return this;
        },
      };

      const originalFindOne = User.findOne;
      User.findOne = async () => mockUser;

      try {
        const { req, res } = createMockReqRes({
          params: { token: rawToken },
          body: { password: "AlternativeFieldPassword123!" },
        });

        await authController.resetPassword(req, res);

        assert.equal(res.statusCode, 200);
        const isMatch = await bcrypt.compare("AlternativeFieldPassword123!", mockUser.password);
        assert.equal(isMatch, true);
      } finally {
        User.findOne = originalFindOne;
      }
    });

    it("should reject expired reset token with 400 Bad Request", async () => {
      const originalFindOne = User.findOne;
      // Expired token query returns null
      User.findOne = async () => null;

      try {
        const { req, res } = createMockReqRes({
          params: { token: "expired-token" },
          body: { newPassword: "NewPassword123!" },
        });

        await authController.resetPassword(req, res);

        assert.equal(res.statusCode, 400);
        assert.equal(res.jsonData.message, "Invalid or expired reset token");
      } finally {
        User.findOne = originalFindOne;
      }
    });

    it("should reject invalid/tampered reset token with 400 Bad Request", async () => {
      const originalFindOne = User.findOne;
      User.findOne = async () => null;

      try {
        const { req, res } = createMockReqRes({
          params: { token: "invalid-tampered-token" },
          body: { newPassword: "NewPassword123!" },
        });

        await authController.resetPassword(req, res);

        assert.equal(res.statusCode, 400);
        assert.equal(res.jsonData.message, "Invalid or expired reset token");
      } finally {
        User.findOne = originalFindOne;
      }
    });

    it("should reject missing or short password with 400 Bad Request", async () => {
      const { req: req1, res: res1 } = createMockReqRes({
        params: { token: "valid-token" },
        body: { newPassword: "123" }, // less than 6 chars
      });

      await authController.resetPassword(req1, res1);
      assert.equal(res1.statusCode, 400);
      assert.ok(res1.jsonData.message.includes("at least 6 characters"));

      const { req: req2, res: res2 } = createMockReqRes({
        params: { token: "valid-token" },
        body: {}, // missing password
      });

      await authController.resetPassword(req2, res2);
      assert.equal(res2.statusCode, 400);
    });
  });

  // ─── 4. FULL FLOW SIMULATION (FORGOT -> EMAIL -> RESET -> LOGIN) ────────────
  describe("End-to-End Forgot & Reset Password Flow Simulation", () => {
    it("should complete the full lifecycle: request forgot password, receive token in email, reset password, and authenticate", async () => {
      let interceptedEmail = null;

      // Mock nodemailer
      const originalCreateTransport = nodemailer.createTransport;
      nodemailer.createTransport = () => ({
        sendMail: async (options) => {
          interceptedEmail = options;
          return { messageId: "mock-e2e" };
        },
      });

      // In-memory simulated database state for user
      const initialPassword = "OldOriginalPassword999";
      const dbUser = {
        _id: "user_sim_123",
        Fullname: "Alice Cooper",
        email: "alice@example.com",
        phone: "0788123456",
        role: "buyer",
        gender: "female",
        password: await bcrypt.hash(initialPassword, 10),
        resetPasswordToken: undefined,
        resetPasswordExpires: undefined,
        save: async function () {
          return this;
        },
      };

      const originalFindOne = User.findOne;
      User.findOne = async (query) => {
        if (query.email === "alice@example.com") {
          return dbUser;
        }
        if (query.resetPasswordToken) {
          if (
            query.resetPasswordToken === dbUser.resetPasswordToken &&
            query.resetPasswordExpires &&
            query.resetPasswordExpires.$gt < dbUser.resetPasswordExpires.getTime()
          ) {
            return dbUser;
          }
        }
        return null;
      };

      try {
        // Step 1: User requests password reset via forgotPassword
        const { req: forgotReq, res: forgotRes } = createMockReqRes({
          body: { email: "alice@example.com" },
        });

        await authController.forgotPassword(forgotReq, forgotRes);
        assert.equal(forgotRes.statusCode, 200);

        // Step 2: User receives email with reset link containing the token
        assert.ok(interceptedEmail, "User must receive reset email");
        assert.equal(interceptedEmail.to, "alice@example.com");

        const tokenMatch = interceptedEmail.text.match(/\/reset-password\/([a-f0-9]{64})/);
        assert.ok(tokenMatch, "Reset link in email must contain token");
        const receivedToken = tokenMatch[1];

        // Step 3: User clicks link and submits resetPassword with new password
        const brandNewPassword = "BrandNewSuperSecret2026!";
        const { req: resetReq, res: resetRes } = createMockReqRes({
          params: { token: receivedToken },
          body: { newPassword: brandNewPassword },
        });

        await authController.resetPassword(resetReq, resetRes);
        assert.equal(resetRes.statusCode, 200);
        assert.ok(resetRes.jsonData.message.includes("Password reset successful"));

        // Step 4: Verify DB token state was cleared
        assert.equal(dbUser.resetPasswordToken, undefined);
        assert.equal(dbUser.resetPasswordExpires, undefined);

        // Step 5: Verify login with OLD password fails
        const oldMatch = await bcrypt.compare(initialPassword, dbUser.password);
        assert.equal(oldMatch, false, "Old password must no longer match");

        // Step 6: Verify login with NEW password succeeds
        const newMatch = await bcrypt.compare(brandNewPassword, dbUser.password);
        assert.equal(newMatch, true, "New password must successfully authenticate");
      } finally {
        nodemailer.createTransport = originalCreateTransport;
        User.findOne = originalFindOne;
      }
    });
  });
});

