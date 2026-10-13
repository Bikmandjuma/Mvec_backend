const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const db = require("./helpers/mysql"); // test database (store lookups are real)
const orm = require("../src/database/orm");
const Staff = require("../src/models/Staff");
const User = require("../src/models/User");
const authController = require("../src/controllers/auth.controller");
const staffController = require("../src/controllers/staff.controller");

function createMockReqRes({ body = {}, user } = {}) {
  const req = {
    body,
    params: {},
    user: user || {
      id: new orm.Types.ObjectId().toString(),
      role: "vendor",
    },
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

describe("Vendor account team", () => {
  it("creates staff without requiring an associated store", async () => {
    const ownerId = new orm.Types.ObjectId().toString();
    const memberId = new orm.Types.ObjectId();
    const originalUserFindOne = User.findOne;
    const originalStaffFindOne = Staff.findOne;
    const originalStaffCreate = Staff.create;
    const originalGetTransporter = authController.getTransporter;
    let createdRecord;
    let inviteEmail;

    User.findOne = async (query) => {
      assert.deepEqual(query, { email: "teammate@example.rw" });
      return {
        _id: memberId,
        Fullname: "Team Member",
        email: "teammate@example.rw",
      };
    };
    Staff.findOne = async (query) => {
      assert.equal(query.vendorOwner, ownerId);
      assert.deepEqual(query.$or, [
        { email: "teammate@example.rw" },
        { user: memberId },
      ]);
      return null;
    };
    Staff.create = async (record) => {
      createdRecord = record;
      return {
        _id: new orm.Types.ObjectId(),
        ...record,
        deleteOne: async () => {},
      };
    };
    authController.getTransporter = () => ({
      sendMail: async (message) => {
        inviteEmail = message;
      },
    });

    try {
      const { req, res } = createMockReqRes({
        user: { id: ownerId, role: "vendor" },
        body: {
          email: " Teammate@Example.RW ",
          role: "CATALOG_MANAGER",
        },
      });

      await staffController.addStaffMember(req, res);

      assert.equal(res.statusCode, 201);
      assert.equal(createdRecord.vendorOwner, ownerId);
      assert.equal(createdRecord.user, memberId);
      assert.equal(createdRecord.role, "CATALOG_MANAGER");
      assert.equal(createdRecord.status, "INVITED");
      assert.equal("store" in createdRecord, false);
      assert.equal(inviteEmail.to, "teammate@example.rw");
      assert.match(inviteEmail.subject, /invited/i);
      assert.match(inviteEmail.text, /\/login/);
      assert.match(inviteEmail.text, /\/signup/);
      assert.equal(
        "invitationTokenHash" in res.jsonData.staff,
        false,
      );
    } finally {
      User.findOne = originalUserFindOne;
      Staff.findOne = originalStaffFindOne;
      Staff.create = originalStaffCreate;
      authController.getTransporter = originalGetTransporter;
    }
  });

  it("does not keep the staff record if the invitation email cannot be sent", async () => {
    const originalUserFindOne = User.findOne;
    const originalStaffFindOne = Staff.findOne;
    const originalStaffCreate = Staff.create;
    const originalGetTransporter = authController.getTransporter;
    let removed = false;

    User.findOne = async () => ({
      _id: new orm.Types.ObjectId(),
      email: "teammate@example.rw",
    });
    Staff.findOne = async () => null;
    Staff.create = async (record) => ({
      ...record,
      deleteOne: async () => {
        removed = true;
      },
    });
    authController.getTransporter = () => ({
      sendMail: async () => {
        throw new Error("SMTP unavailable");
      },
    });

    try {
      const { req, res } = createMockReqRes({
        body: { email: "teammate@example.rw", role: "ORDER_MANAGER" },
      });

      await staffController.addStaffMember(req, res);

      assert.equal(res.statusCode, 500);
      assert.match(res.jsonData.message, /invitation email/i);
      assert.equal(removed, true);
    } finally {
      User.findOne = originalUserFindOne;
      Staff.findOne = originalStaffFindOne;
      Staff.create = originalStaffCreate;
      authController.getTransporter = originalGetTransporter;
    }
  });

  it("creates an invitation for an email with no account yet", async () => {
    await db.setup();
    const owner = new orm.Types.ObjectId().toString();
    const originalUserFindOne = User.findOne;
    const originalStaffFindOne = Staff.findOne;
    const originalStaffCreate = Staff.create;
    const originalGetTransporter = authController.getTransporter;
    let createdRecord;
    let recipient;

    User.findOne = async () => null;
    Staff.findOne = async (query) => {
      assert.deepEqual(query, {
        vendorOwner: owner,
        email: "new.member@example.rw",
      });
      return null;
    };
    Staff.create = async (record) => {
      createdRecord = record;
      return { _id: new orm.Types.ObjectId(), ...record };
    };
    authController.getTransporter = () => ({
      sendMail: async ({ to }) => {
        recipient = to;
      },
    });

    try {
      const { req, res } = createMockReqRes({
        user: { id: owner, role: "vendor" },
        body: { email: "New.Member@Example.RW", role: "ORDER_MANAGER" },
      });

      await staffController.addStaffMember(req, res);

      assert.equal(res.statusCode, 201);
      assert.equal(recipient, "new.member@example.rw");
      assert.equal(createdRecord.user, undefined);
      assert.equal(createdRecord.status, "INVITED");
      assert.ok(createdRecord.invitationTokenHash);
    } finally {
      User.findOne = originalUserFindOne;
      Staff.findOne = originalStaffFindOne;
      Staff.create = originalStaffCreate;
      authController.getTransporter = originalGetTransporter;
    }
  });

  it("lists staff by vendor account without requiring a store", async () => {
    await db.setup();
    const ownerId = new orm.Types.ObjectId().toString();
    const member = { _id: new orm.Types.ObjectId(), role: "ORDER_MANAGER", status: "ACTIVE", user: { Fullname: "Member", email: "m@example.rw" } };
    const originalStaffFind = Staff.find;
    const originalUserFindById = User.findById;

    Staff.find = (query) => {
      assert.deepEqual(query, { vendorOwner: ownerId });
      return { populate: () => ({ sort: async () => [member] }) };
    };
    User.findById = () => ({ select: async () => ({ _id: ownerId, Fullname: "Owner", email: "o@example.rw", createdAt: new Date() }) });

    try {
      const { req, res } = createMockReqRes({ user: { id: ownerId, role: "vendor" } });
      await staffController.getStoreStaff(req, res);

      assert.equal(res.statusCode, 200, JSON.stringify(res.jsonData));
      const rows = res.jsonData.staff || res.jsonData.data;
      assert.equal(rows[0].role, "OWNER", "the owner is listed first");
      assert.ok(rows.some((r) => String(r._id || r.id) === String(member._id)), "members follow");
    } finally {
      Staff.find = originalStaffFind;
      User.findById = originalUserFindById;
    }
  });

  it("allows staff records without a store reference", async () => {
    const staff = new Staff({
      vendorOwner: new orm.Types.ObjectId(),
      user: new orm.Types.ObjectId(),
    });

    await assert.doesNotReject(staff.validate());
    assert.equal(staff.store, undefined);
  });
});

require("node:test").after(() => db.close());
