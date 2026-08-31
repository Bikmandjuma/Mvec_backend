// src/models/Payment.js
const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema(
  {
    parentOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      required: true,
    },
    transactionReference: {
      type: String,
      unique: true,
    },
    method: {
      type: String,
      enum: ["MOMO", "AIRTEL", "MOBILE_MONEY", "CARD", "BANK_TRANSFER", "GATEWAY", "CASH_ON_DELIVERY"],
      required: true,
    },
    phoneNumber: {
      type: String, // Stores formatted Rwandan line (e.g., 250788123456)
    },
    provider: {
      type: String,
      enum: ["MTN", "AIRTEL", "UNKNOWN"],
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

const Payment = mongoose.model("Payment", paymentSchema);

module.exports = Payment;