const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    parentOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
      index: true,
    },
    transactionReference: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    // Provider-generated reference returned by the gateway (used by the
    // webhook to reconcile the callback back to this payment).
    gatewayReference: {
      type: String,
      unique: true,
      index: true,
      sparse: true,
    },
    method: {
      type: String,
      enum: ["MOMO", "AIRTEL", "CASH_ON_DELIVERY"],
      required: true,
    },
    phoneNumber: {
      type: String, // E.g., 250788XXXXXX or 25073XXXXXXX
    },
    provider: {
      type: String,
      enum: ["MTN", "AIRTEL", "CASH"],
      required: true,
    },
    status: {
      type: String,
      enum: ["PENDING", "PROCESSING", "SUCCESS", "FAILED", "REFUNDED", "CANCELLED"],
      default: "PENDING",
    },
    amount: {
      type: Number,
      required: true,
    },
    currency: {
      type: String,
      default: "RWF",
    },
    gatewayResponse: {
      type: Object,
    },
    paidAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model("Payment", paymentSchema);