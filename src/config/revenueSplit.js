const TOTAL_PLATFORM_FEE_PERCENT = 5;
const DEVELOPER_PERCENT = 1;
const AFFILIATE_PERCENT = 0.5;

function computeRevenueSplit({ grossTotal, hasAffiliate, gatewayFee = 0 }) {
  const totalPlatformFee = (grossTotal * TOTAL_PLATFORM_FEE_PERCENT) / 100;
  const developerShare = (grossTotal * DEVELOPER_PERCENT) / 100;
  const affiliateShare = hasAffiliate ? (grossTotal * AFFILIATE_PERCENT) / 100 : 0;
  const adminShare = Math.max(0, totalPlatformFee - gatewayFee - developerShare - affiliateShare);
  const vendorNet = grossTotal - totalPlatformFee;

  return {
    vendorNet,
    totalPlatformFee,
    gatewayFee,
    developerShare,
    affiliateShare,
    adminShare,
  };
}

module.exports = {
  TOTAL_PLATFORM_FEE_PERCENT,
  DEVELOPER_PERCENT,
  AFFILIATE_PERCENT,
  computeRevenueSplit,
};
