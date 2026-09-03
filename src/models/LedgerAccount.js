const mongoose = require("mongoose");

const ledgerAccountSchema = new mongoose.Schema(
  {
    accountNumber: { type: String, required: true, unique: true, index: true },
    accountType: {
      type: String,
      enum: [
        "ESCROW_HOLDING",
        "PLATFORM_REVENUE",
        "VENDOR_PAYABLE",
        "SUPPLIER_PAYABLE",
        "COURIER_PAYABLE",
        "BUYER_REFUND_HOLD",
      ],
      required: true,
    },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    currency: { type: String, default: "RWF", required: true },
    balance: { type: Number, default: 0, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("LedgerAccount", ledgerAccountSchema);