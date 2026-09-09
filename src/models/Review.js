const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    parentOrder: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    reviewText: String,
    images: [String],
    status: {
      type: String,
      enum: ["PENDING", "PUBLISHED", "HIDDEN"],
      default: "PUBLISHED",
    },
    isVerifiedPurchase: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Prevent multiple reviews per single product order by the user
reviewSchema.index({ user: 1, product: 1, parentOrder: 1 }, { unique: true });

module.exports = mongoose.model("Review", reviewSchema);
