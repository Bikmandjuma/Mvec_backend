const mongoose = require("mongoose");

const settlementSchema = new mongoose.Schema(
  {
    settlementReference: { type: String, required: true, unique: true, index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    grossAmount: { type: Number, required: true },
    commissionAmount: { type: Number, required: true },
    netAmount: { type: Number, required: true },
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