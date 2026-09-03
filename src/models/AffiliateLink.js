const mongoose = require("mongoose");

const affiliateLinkSchema = new mongoose.Schema(
  {
    affiliateCode: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    affiliateUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    targetProduct: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Product",
    },
    clickCount: {
      type: Number,
      default: 0,
    },
    conversionCount: {
      type: Number,
      default: 0,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("AffiliateLink", affiliateLinkSchema);