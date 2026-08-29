const mongoose = require("mongoose");

// Vendor Balance Summary Ledger
const vendorBalanceSchema = new mongoose.Schema(
  {
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    store: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Store",
    },
    totalEarned: { type: Number, default: 0 },      // Total gross vendor earnings lifetime
    commissionPaid: { type: Number, default: 0 },  // Total platform fees deducted lifetime
    pendingBalance: { type: Number, default: 0 },  // Earnings from active/undelivered orders
    availableBalance: { type: Number, default: 0 },// Funds available for immediate payout
    withdrawnAmount: { type: Number, default: 0 }, // Total payouts completed
  },
  { timestamps: true }
);

// Individual Payout Request Record
const payoutSchema = new mongoose.Schema(
  {
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    payoutNumber: {
      type: String,
      unique: true,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: [1000, "Minimum payout request amount is 1,000"],
    },
    payoutMethod: {
      type: String,
      enum: ["BANK_TRANSFER", "MOBILE_MONEY"],
      default: "MOBILE_MONEY",
    },
    payoutDetails: {
      accountName: { type: String, required: true },
      accountNumber: { type: String, required: true }, // Phone number or Bank account #
      bankName: { type: String, default: "MTN MoMo" },
    },
    status: {
      type: String,
      enum: ["PENDING", "PROCESSING", "PAID", "REJECTED"],
      default: "PENDING",
    },
    rejectionReason: String,
    processedAt: Date,
  },
  { timestamps: true }
);

const VendorBalance = mongoose.model("VendorBalance", vendorBalanceSchema);
const Payout = mongoose.model("Payout", payoutSchema);

module.exports = { VendorBalance, Payout };