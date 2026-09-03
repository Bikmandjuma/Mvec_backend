const CommissionRule = require("../models/CommissionRule");
const PricingSnapshot = require("../models/PricingSnapshot");

/**
 * Evaluates the best applicable commission rule for a given product/vendor item
 */
async function getApplicableCommissionRule({ productId, vendorId, categoryId }) {
  // Query all active potential rules matching target criteria
  const activeRules = await CommissionRule.find({
    isActive: true,
    $or: [
      { ruleType: "PRODUCT", targetProduct: productId },
      { ruleType: "VENDOR", targetVendor: vendorId },
      { ruleType: "CATEGORY", targetCategory: categoryId },
      { ruleType: "GLOBAL" },
    ],
  }).sort({ priority: -1, createdAt: -1 });

  if (!activeRules.length) {
    // Default fallback rule if none configured
    return {
      _id: null,
      rateType: "PERCENTAGE",
      rateValue: 10, // Default 10% platform fee
    };
  }

  // Highest priority rule wins
  return activeRules[0];
}

/**
 * Calculates item totals, computes dynamic platform commission, and writes snapshot
 */
exports.createItemPricingSnapshot = async ({ orderId, item, session }) => {
  const { product, vendor, category, price, quantity } = item;
  const unitPrice = price;
  const grossTotal = unitPrice * quantity;

  // 1. Evaluate applicable dynamic commission rule
  const rule = await getApplicableCommissionRule({
    productId: product._id || product,
    vendorId: vendor._id || vendor,
    categoryId: category,
  });

  // 2. Compute commission amount
  let commissionAmount = 0;
  if (rule.rateType === "PERCENTAGE") {
    commissionAmount = (grossTotal * rule.rateValue) / 100;
  } else if (rule.rateType === "FIXED") {
    commissionAmount = rule.rateValue * quantity;
  }

  // Ensure commission does not exceed total price
  commissionAmount = Math.min(commissionAmount, grossTotal);
  const vendorNetEarnings = grossTotal - commissionAmount;

  // 3. Create frozen PricingSnapshot record
  const snapshot = await PricingSnapshot.create(
    [
      {
        order: orderId,
        product: product._id || product,
        vendor: vendor._id || vendor,
        unitPrice,
        quantity,
        grossTotal,
        commissionRuleApplied: rule._id,
        commissionRateType: rule.rateType,
        commissionRateValue: rule.rateValue,
        commissionAmount,
        vendorNetEarnings,
      },
    ],
    { session }
  );

  return snapshot[0];
};