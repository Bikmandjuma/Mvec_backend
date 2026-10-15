// What the app needs besides models: ObjectId helpers and transactions.
// Ids stay 24-character hex strings (CHAR(24) primary keys), so links and API
// responses are unchanged. startSession() opens a MySQL transaction.
const { ObjectId } = require("bson");
const { CompatSession } = require("./mongoose-compat/session");
require("./mongoose-compat/convert"); // gives ObjectId its Mongoose-style `_id`

const HEX24 = /^[a-f0-9]{24}$/i;
const isValidObjectId = (v) => {
  if (v === null || v === undefined) return false;
  if (v instanceof ObjectId || v._bsontype === "ObjectId") return true;
  return HEX24.test(String(v));
};

module.exports = {
  Types: { ObjectId },
  isValidObjectId,
  startSession: async () => new CompatSession(),
};
