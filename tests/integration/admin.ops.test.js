require("../helpers/jest-shim"); // Jest-style API on node:test
const db = require("../helpers/mysql"); // MySQL test database (first, before models)
const request = require("supertest");
const jwt = require("jsonwebtoken");
const express = require("express");
const User = require("../../src/models/User");
const Vendor = require("../../src/models/Vendor");
const Supplier = require("../../src/models/Supplier");
const Notification = require("../../src/models/Notification");
const AuditLog = require("../../src/models/AuditLog");

jest.setTimeout(60000);

const waitFor = async (check, tries = 20) => {
  for (let i = 0; i < tries; i += 1) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
};

describe("Admin operations: verification, attention queue, audit log", () => {
  let app;
  let admin;
  let seller;
  let supplierUser;
  let buyer;
  const tokens = {};
  const secret = "admin_ops_test_secret";
  const profile = {
    businessName: "Nyamirambo Crafts", phone: "0788123456", email: "crafts@example.com",
    description: "Handmade baskets and decor.", logoUrl: "https://example.com/logo.png", category: "Home", location: "Kigali",
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = secret;
    await db.setup();
    app = express();
    app.use(express.json());
    app.use(require("../../src/middleware/adminAudit"));
    app.use("/api/vendors", require("../../src/routes/vendor.routes"));
    app.use("/api/admin/vendors", require("../../src/routes/admin.vendor.routes"));
    app.use("/api/admin/suppliers", require("../../src/routes/admin.supplier.routes"));
    app.use("/api/suppliers", require("../../src/routes/supplier.routes"));
    app.use("/api/admin", require("../../src/routes/admin.ops.routes"));
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.reset();
    const make = (name, role, n) => User.create({ Fullname: name, companyName: ["vendor", "supplier"].includes(role) ? name : undefined, email: `${role}${n}@example.com`, password: "password123", phone: `078800000${n}`, gender: "female", role });
    admin = await make("Ops Admin", "super_admin", 1);
    seller = await make("Craft Seller", "vendor", 2);
    supplierUser = await make("Bulk Supplier", "supplier", 3);
    buyer = await make("Some Buyer", "buyer", 4);
    for (const [k, u] of Object.entries({ admin, seller, supplierUser, buyer })) tokens[k] = jwt.sign({ userId: u._id }, secret);
  });

  const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });

  test("a submitted seller profile alerts admins and shows in the attention queue", async () => {
    const res = await request(app).post("/api/vendors/onboard").set(as("seller")).send(profile);
    expect([200, 201]).toContain(res.status);
    const alert = await waitFor(() => Notification.findOne({ recipient: admin._id, type: "ADMIN" }));
    expect(alert.title).toMatch(/seller profile to verify: Nyamirambo Crafts/);

    const queue = await request(app).get("/api/admin/attention").set(as("admin"));
    expect(queue.status).toBe(200);
    expect(queue.body.items.find((i) => i.key === "vendors").count).toBe(1);
    expect(queue.body.badges["/admin/vendors"]).toBe(1);
  });

  test("rejecting needs a reason, which the seller is told; verifying clears it; both are audited", async () => {
    await request(app).post("/api/vendors/onboard").set(as("seller")).send(profile);
    const vendor = await Vendor.findOne({ user: seller._id });

    const noReason = await request(app).patch(`/api/admin/vendors/${vendor._id}/verify`).set(as("admin")).send({ decision: "REJECTED" });
    expect(noReason.status).toBe(400);

    const reject = await request(app).patch(`/api/admin/vendors/${vendor._id}/verify`).set(as("admin")).send({ decision: "REJECTED", reason: "Please upload a clear logo." });
    expect(reject.status).toBe(200);
    expect((await Vendor.findById(vendor._id)).verificationNote).toBe("Please upload a clear logo.");
    const told = await Notification.findOne({ recipient: seller._id, type: "ADMIN" });
    expect(told.title).toMatch(/needs changes/);
    expect(told.message).toMatch(/Please upload a clear logo/);

    const verify = await request(app).patch(`/api/admin/vendors/${vendor._id}/verify`).set(as("admin")).send({ decision: "VERIFIED" });
    expect(verify.status).toBe(200);
    const saved = await Vendor.findById(vendor._id);
    expect(saved.verificationStatus).toBe("VERIFIED");
    expect(saved.verificationNote).toBe("");

    const logged = await waitFor(async () => ((await AuditLog.countDocuments({ targetId: String(vendor._id) })) === 2 ? true : null));
    expect(logged).toBe(true);
    const log = await request(app).get(`/api/admin/audit-logs?targetId=${vendor._id}`).set(as("admin"));
    expect(log.body.data.map((r) => r.action).sort()).toEqual(["Seller rejected", "Seller verified"]);
    expect(log.body.data[0].actor).toBe("Ops Admin");
    // Failed attempts (the 400 above) are not audited.
    expect(log.body.meta.total).toBe(2);
  });

  test("a rejected supplier who fixes their profile goes back for review automatically", async () => {
    await request(app).post("/api/suppliers/onboard").set(as("supplierUser")).send({ ...profile, businessName: "Kigali Bulk" });
    const supplier = await Supplier.findOne({ user: supplierUser._id });
    await request(app).patch(`/api/admin/suppliers/${supplier._id}/verify`).set(as("admin")).send({ decision: "REJECTED", reason: "The phone number does not answer." });
    expect((await Supplier.findById(supplier._id)).verificationStatus).toBe("REJECTED");

    const fix = await request(app).patch("/api/suppliers/me/profile").set(as("supplierUser")).send({ phone: "0788999888", category: "Electronics" });
    expect(fix.status).toBe(200);
    expect(fix.body.message).toMatch(/review again/);
    const saved = await Supplier.findById(supplier._id);
    expect(saved.verificationStatus).toBe("PENDING");
    expect(saved.category).toBe("Electronics");
  });

  test("the operations endpoints are admin-only and answer for an empty marketplace", async () => {
    for (const path of ["attention", "payments", "earnings", "analytics", "risk", "trust", "platform", "audit-logs"]) {
      const denied = await request(app).get(`/api/admin/${path}`).set(as("buyer"));
      expect(denied.status).toBe(403);
      const ok = await request(app).get(`/api/admin/${path}`).set(as("admin"));
      expect(ok.status).toBe(200);
    }
    const platform = await request(app).get("/api/admin/platform").set(as("admin"));
    expect(platform.body.fees[0].value).toBe("5%");
    expect(platform.body.commissionRules.applied).toBe(false);
  });
});
