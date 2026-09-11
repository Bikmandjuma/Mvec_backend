const mongoose = require("mongoose");

const settlementSchema = new mongoose.Schema(
  {
    settlementReference: { type: String, required: true, unique: true, index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    grossAmount: { type: Number, required: true },
    commissionAmount: { type: Number, required: true },
    netAmount: { type: Number, required: true },
    developerShare: { type: Number, default: 0 },
    adminShare: { type: Number, default: 0 },
    affiliateShare: { type: Number, default: 0 },
    gatewayFee: { type: Number, default: 0 },
    affiliateUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    status: {
      type: String,
      enum: ["HELD", "RELEASED", "ADMIN_HOLD", "REFUNDED", "CANCELLED"],
      default: "HELD",
      required: true,
    },
    releasedAt: { type: Date, default: null },
    adminHoldReason: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Settlement", settlementSchema);