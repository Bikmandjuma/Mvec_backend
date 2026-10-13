// MySQL models (Sequelize) behind the Mongoose-style API in src/database/mongoose-compat.
const { model } = require("../database/mongoose-compat");

module.exports = { VendorBalance: model("VendorBalance"), Payout: model("Payout") };
