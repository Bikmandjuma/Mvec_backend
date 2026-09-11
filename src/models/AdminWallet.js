const mongoose = require("mongoose");

const adminWalletSchema = new mongoose.Schema(
  {
    adminUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
      index: true,
    },
    pendingBalance: { type: Number, default: 0, min: 0 },
    availableBalance: { type: Number, default: 0, min: 0 },
    totalEarned: { type: Number, default: 0, min: 0 },
    totalWithdrawn: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AdminWallet", adminWalletSchema);
