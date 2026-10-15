// MySQL (DB_DRIVER=mysql): same API, backed by Sequelize. See src/database/mongoose-compat.
if (require("../database/driver").isMysql) {
  module.exports = require("../database/mongoose-compat").model("Order");
  return;
}

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
  // Coupon discount on this line (RWF), paid by the seller.
  discount: { type: Number, default: 0 },
});

const orderSchema = new mongoose.Schema(
  {
    // Buyer account. Manual orders for walk-in / phone customers may have none;
    // their contact details are kept in `customer`.
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: function () { return this.source !== "MANUAL"; },
    },
    // ONLINE = placed by the buyer at checkout; MANUAL = recorded by the seller.
    source: { type: String, enum: ["ONLINE", "MANUAL"], default: "ONLINE", index: true },
    customer: {
      name: String,
      phone: String,
      email: String,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    // Paid to the seller outside MVEC (cash / MoMo / bank): no escrow, no wallet credit.
    paidOffline: { type: Boolean, default: false },
    offlinePaymentMethod: { type: String, enum: ["CASH", "MOMO", "BANK", null], default: null },
    sellerNote: { type: String, default: "", maxlength: 500 },
    orderNumber: {
      type: String,
      unique: true,
      required: true,
    },
    items: [orderItemSchema],
    shippingAddress: {
      street: { type: String, required: true },
      city: { type: String, required: true }, // district
      state: { type: String, required: true }, // province
      country: { type: String, required: true },
      postalCode: String,
      province: String,
      district: String,
      sector: String,
    },
    // totalAmount = subtotal (items) + shippingFee (all parcels).
    subtotal: { type: Number, default: null },
    shippingFee: { type: Number, default: 0 },
    shippingMethod: { type: String, enum: ["STANDARD", "EXPRESS", "PICKUP"], default: "STANDARD" },
    // One entry per parcel (seller store); fee is paid to that seller with no commission.
    shippingBreakdown: [
      {
        _id: false,
        vendor: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        store: { type: mongoose.Schema.Types.ObjectId, ref: "Store", default: null },
        storeName: String,
        zone: { type: mongoose.Schema.Types.ObjectId, ref: "ShippingZone", default: null },
        zoneName: String,
        method: String,
        fee: { type: Number, default: 0 },
        originalFee: Number, // before a free-shipping coupon
        eta: String,
      },
    ],
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
      enum: ["MOMO", "AIRTEL", "CASH_ON_DELIVERY", "CARD", "BANK", "CASH"],
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
    // Seller coupon applied at checkout; discountAmount = item + delivery discount.
    coupon: {
      code: String,
      promotion: { type: mongoose.Schema.Types.ObjectId, ref: "Promotion" },
      vendor: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      type: { type: String },
    },
    discountAmount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// Expose `id` alongside `_id` (checkout redirects to /payment/:id).
orderSchema.set("toJSON", { virtuals: true });

module.exports = mongoose.model("Order", orderSchema);
