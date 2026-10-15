const PricingSnapshot = require("../models/PricingSnapshot");
const { computeRevenueSplit } = require("../config/revenueSplit");
const commission = require("./commission.service");

/**
 * Price one paid order line: find the commission rule that applies (seller
 * override, category rate or default), split the money and freeze the result
 * in a pricing snapshot so later rule changes never alter a paid order.
 * Returns the snapshot plus the split details the escrow lock needs.
 */
exports.createItemPricingSnapshot = async ({ orderId, item, session, hasAffiliate = false, gatewayFee = 0, vendorAffiliatePercent = 0 }) => {
  const { product, vendor, category, price, quantity } = item;
  const unitPrice = price;
  // Coupon discounts are paid by the seller, so escrow uses the discounted line.
  const grossTotal = Math.max(0, unitPrice * quantity - (Number(item.discount) || 0));

  const split = await commission.splitFor({
    vendorId: vendor._id || vendor,
    categoryId: category,
    grossTotal,
    hasAffiliate,
    gatewayFee,
    vendorAffiliatePercent,
  });

  const [snapshot] = await PricingSnapshot.create(
    [
      {
        order: orderId,
        product: product._id || product,
        vendor: vendor._id || vendor,
        unitPrice,
        quantity,
        grossTotal,
        commissionRuleApplied: split.rule?._id || null,
        commissionRateType: "PERCENTAGE",
        commissionRateValue: split.commissionPercent,
        commissionAmount: split.totalPlatformFee,
        vendorNetEarnings: split.vendorNet,
        developerShare: split.developerShare,
        adminShare: split.adminShare,
        affiliateShare: split.affiliateShare,
        vendorAffiliateShare: split.vendorAffiliateShare,
        gatewayFee: split.gatewayFee,
        hasAffiliate,
      },
    ],
    { session }
  );

  const plain = typeof snapshot.toObject === "function" ? snapshot.toObject() : snapshot;
  return { ...plain, totalPlatformFee: split.totalPlatformFee, vendorNet: split.vendorNet, commissionRate: split.commissionPercent, gatewayFeePayer: split.gatewayFeePayer, commissionSource: split.source };
};

exports.computeRevenueSplit = computeRevenueSplit;
