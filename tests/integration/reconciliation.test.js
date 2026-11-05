require("../helpers/jest-shim"); // Jest-style API on node:test
const db = require("../helpers/mysql"); // MySQL test database (first, before models)
const request = require("supertest");
const jwt = require("jsonwebtoken");
const express = require("express");
const orm = require("../../src/database/orm");
const User = require("../../src/models/User");
const Payment = require("../../src/models/Payment");
const PaymentWebhookLog = require("../../src/models/PaymentWebhookLog");

jest.setTimeout(60000);

describe("Admin reconciliation: provider statement vs MVEC records", () => {
  let app;
  const tokens = {};
  const secret = "reconcile_test_secret";
  const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });

  beforeAll(async () => {
    process.env.JWT_SECRET = secret;
    await db.setup();
    app = express();
    app.use(express.json());
    app.use("/api/admin", require("../../src/routes/admin.financial.routes"));
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.reset();
    const admin = await User.create({ Fullname: "Fin Admin", email: "fin@example.com", password: "password123", phone: "0788000201", role: "super_admin" });
    const buyer = await User.create({ Fullname: "Buyer", email: "b@example.com", password: "password123", phone: "0788000202", role: "buyer" });
    tokens.admin = jwt.sign({ userId: admin._id }, secret);
    tokens.buyer = jwt.sign({ userId: buyer._id }, secret);

    const paidAt = new Date("2026-11-01T10:00:00Z");
    // An order payment confirmed by webhook.
    await PaymentWebhookLog.create({ provider: "PAYPACK", externalTransactionId: "PP-1", status: "PROCESSED", amount: 10000, internalOrderId: new orm.Types.ObjectId(), rawPayload: {} });
    // A payment confirmed by polling (no webhook log).
    await Payment.create({ transactionReference: "PAY-2", gatewayReference: "PP-2", gateway: "PAYPACK", method: "MOMO", provider: "MTN", amount: 5000, status: "SUCCESS", paidAt, user: buyer._id });
    // Recorded as paid by MVEC but absent from the statement.
    await Payment.create({ transactionReference: "PAY-3", gatewayReference: "PP-3", gateway: "PAYPACK", method: "MOMO", provider: "MTN", amount: 7000, status: "SUCCESS", paidAt, user: buyer._id });
  });

  test("classifies every statement row and lists MVEC payments missing from the statement", async () => {
    const res = await request(app).post("/api/admin/reconcile").set(as("admin")).send({
      from: "2026-11-01T00:00:00Z",
      to: "2026-11-02T00:00:00Z",
      statements: [
        { provider: "MTN", externalTransactionId: "PP-1", amount: 10000, transactionDate: "2026-11-01T10:00:00Z" },
        { provider: "MTN", externalTransactionId: "PP-2", amount: 5500, transactionDate: "2026-11-01T10:00:00Z" },
        { provider: "PAYPACK", externalTransactionId: "PP-9", amount: 2000, transactionDate: "2026-11-01T10:00:00Z" },
      ],
    });
    expect(res.status).toBe(200);
    const r = res.body.results;
    expect(r.matched).toBe(1);
    expect(r.mismatched).toBe(1);
    expect(r.missingInLedger).toBe(1);
    expect(r.statementTotal).toBe(17500);
    expect(r.rows.find((x) => x.externalTransactionId === "PP-2").recorded).toBe(5000);
    expect(r.missingInStatement.map((p) => p.gatewayReference)).toEqual(["PP-3"]);
  });

  test("rejects an empty statement and non-admins", async () => {
    expect((await request(app).post("/api/admin/reconcile").set(as("admin")).send({ statements: [] })).status).toBe(400);
    expect((await request(app).post("/api/admin/reconcile").set(as("buyer")).send({ statements: [{ externalTransactionId: "x", amount: 1 }] })).status).toBe(403);
  });
});
