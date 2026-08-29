const mongoose = require("mongoose");

const storeSchema = new mongoose.Schema(
  {
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true, // One store per vendor user account
    },
    storeName: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
    },
    logo: { type: String, default: "" },
    banner: { type: String, default: "" },
    description: { type: String, default: "" },
    businessCategory: { type: String, default: "General" },
    contactEmail: { type: String, required: true },
    contactPhone: { type: String, required: true },
    address: {
      street: String,
      city: { type: String, default: "Kigali" },
      country: { type: String, default: "Rwanda" },
    },
    policies: {
      returnPolicy: { type: String, default: "" },
      shippingPolicy: { type: String, default: "" },
    },
    socialLinks: {
      website: String,
      instagram: String,
      twitter: String,
    },
    status: {
      type: String,
      enum: ["PENDING", "ACTIVE", "SUSPENDED", "REJECTED", "CLOSED"],
      default: "PENDING",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Store", storeSchema);