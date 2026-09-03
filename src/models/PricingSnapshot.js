const mongoose = require("mongoose");

const pricingSnapshotSchema = new mongoose.Schema(
  {
    order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
    vendor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    
    unitPrice: { type: Number, required: true }, // Base price at checkout
    quantity: { type: Number, required: true },
    grossTotal: { type: Number, required: true }, // unitPrice * quantity
    
    // Applied Dynamic Commission
    commissionRuleApplied: { type: mongoose.Schema.Types.ObjectId, ref: "CommissionRule", default: null },
    commissionRateType: { type: String, enum: ["PERCENTAGE", "FIXED"], required: true },
    commissionRateValue: { type: Number, required: true },
    commissionAmount: { type: Number, required: true }, // Total platform cut for this item
    
    vendorNetEarnings: { type: Number, required: true }, // grossTotal - commissionAmount
    currency: { type: String, default: "RWF", required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("PricingSnapshot", pricingSnapshotSchema);