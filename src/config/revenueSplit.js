const TOTAL_PLATFORM_FEE_PERCENT = 5;
const DEVELOPER_PERCENT = 1;
const AFFILIATE_PERCENT = 0.5;

// Affiliate commission = MVEC's share (AFFILIATE_PERCENT, out of the platform
// fee) + the seller's own rate (vendorAffiliatePercent, out of the seller's net).
function computeRevenueSplit({ grossTotal, hasAffiliate, gatewayFee = 0, vendorAffiliatePercent = 0 }) {
  const totalPlatformFee = (grossTotal * TOTAL_PLATFORM_FEE_PERCENT) / 100;
  const developerShare = (grossTotal * DEVELOPER_PERCENT) / 100;
  const platformAffiliateShare = hasAffiliate ? (grossTotal * AFFILIATE_PERCENT) / 100 : 0;
  const vendorAffiliateShare = hasAffiliate ? Math.round(grossTotal * (Number(vendorAffiliatePercent) || 0)) / 100 : 0;
  const affiliateShare = platformAffiliateShare + vendorAffiliateShare;
  const adminShare = Math.max(0, totalPlatformFee - gatewayFee - developerShare - platformAffiliateShare);
  const vendorNet = grossTotal - totalPlatformFee - vendorAffiliateShare;

  return {
    vendorNet,
    totalPlatformFee,
    gatewayFee,
    developerShare,
    affiliateShare,
    vendorAffiliateShare,
    adminShare,
  };
}

module.exports = {
  TOTAL_PLATFORM_FEE_PERCENT,
  DEVELOPER_PERCENT,
  AFFILIATE_PERCENT,
  computeRevenueSplit,
};
