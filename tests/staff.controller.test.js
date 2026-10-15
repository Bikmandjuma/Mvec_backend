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
  // Vendor staff are created with a temporary password by the store owner
  // (vendor portal design); the invitation-email tests for the previous
  // controller were removed with it.
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
