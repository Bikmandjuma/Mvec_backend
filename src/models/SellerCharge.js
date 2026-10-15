// MySQL (DB_DRIVER=mysql): same API, backed by Sequelize. See src/database/mongoose-compat.
if (require("../database/driver").isMysql) {
  module.exports = require("../database/mongoose-compat").model("SellerCharge");
  return;
}

const mongoose = require("mongoose");

// Money MVEC takes from a seller's available balance (e.g. a Premium
// subscription renewal), so it shows on the seller's statement.
const sellerChargeSchema = new mongoose.Schema(
  {
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: { type: String, enum: ["SUBSCRIPTION", "ADVERTISING", "ADJUSTMENT"], required: true },
    // Negative amounts are credits (e.g. unspent ad budget returned).
    amount: { type: Number, required: true },
    reference: { type: String, default: "" },
    description: { type: String, default: "" },
    status: { type: String, enum: ["CHARGED", "REFUNDED"], default: "CHARGED" },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SellerCharge", sellerChargeSchema);
