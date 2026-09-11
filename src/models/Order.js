const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Product",
    required: false,
  },
  vendor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: false,
  },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Category",
  },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  quantity: { type: Number, required: true },
  image: { type: String },
});

const orderSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    orderNumber: {
      type: String,
      unique: true,
      required: true,
    },
    items: [orderItemSchema],
    shippingAddress: {
      street: { type: String, required: true },
      city: { type: String, required: true },
      state: { type: String, required: true },
      country: { type: String, required: true },
      postalCode: String,
    },
    totalAmount: { type: Number, required: true },
    paymentStatus: {
      type: String,
      enum: ["PENDING", "CONFIRMED", "PAID", "FAILED", "REFUNDED"],
      default: "PENDING",
    },
    orderStatus: {
      type: String,
      enum: [
        "PENDING",
        "CONFIRMED",
        "PROCESSING",
        "READY_FOR_SHIPMENT",
        "SHIPPED",
        "OUT_FOR_DELIVERY",
        "DELIVERED",
        "COMPLETED",
        "CANCELLED",
        "RETURNED",
        "REFUNDED",
        "FAILED",
      ],
      default: "PENDING",
    },
    paymentMethod: {
      type: String,
      enum: ["MOMO", "AIRTEL", "CASH_ON_DELIVERY", "CARD", "BANK"],
      default: "MOMO",
    },
    deliveryOtp: String,
    isDelivered: {
      type: Boolean,
      default: false,
    },
    deliveredAt: Date,
    slaBreached: {
      type: Boolean,
      default: false,
    },
    slaBreachedAt: {
      type: Date,
    },
    cancellationReason: {
      type: String,
    },
    adminNotes: {
      type: String,
    },
    paymentReference: String,
    affiliateCode: { type: String, default: null },
    affiliateUser: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model("Order", orderSchema);
