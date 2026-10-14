// How the money from one sale is split. The commission rate comes from the
// commission rules (per category, optionally overridden per seller); the
// developer and affiliate shares are percentages OF that commission; and the
// payment provider fee is paid by whoever the payer policy says.
//
// Defaults (used when nothing is configured) reproduce the original model:
// 5% commission, of which 20% (= 1% of the sale) to the developer and 10%
// (= 0.5% of the sale) to an affiliate when the sale came from their link.
const DEFAULT_COMMISSION_PERCENT = 5;
const DEFAULT_DEVELOPER_SHARE = 20; // % of the commission
const DEFAULT_AFFILIATE_SHARE = 10; // % of the commission
const GATEWAY_FEE_PAYERS = ["MVEC", "SELLER"];

// Kept for code and messages that still talk in "percent of the sale".
const TOTAL_PLATFORM_FEE_PERCENT = DEFAULT_COMMISSION_PERCENT;
const DEVELOPER_PERCENT = (DEFAULT_COMMISSION_PERCENT * DEFAULT_DEVELOPER_SHARE) / 100;
const AFFILIATE_PERCENT = (DEFAULT_COMMISSION_PERCENT * DEFAULT_AFFILIATE_SHARE) / 100;

const cents = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Split one order line.
 *  grossTotal              what the buyer paid for the line
 *  commissionPercent       MVEC's commission on this line (from the rules)
 *  developerSharePercent   % of the commission paid to the developer
 *  affiliateSharePercent   % of the commission paid to the affiliate (only if hasAffiliate)
 *  vendorAffiliatePercent  extra % of the sale the seller pays the affiliate (their program)
 *  gatewayFee              provider fee for this line; gatewayFeePayer decides who bears it
 */
function computeRevenueSplit({
  grossTotal,
  hasAffiliate = false,
  gatewayFee = 0,
  vendorAffiliatePercent = 0,
  commissionPercent = DEFAULT_COMMISSION_PERCENT,
  developerSharePercent = DEFAULT_DEVELOPER_SHARE,
  affiliateSharePercent = DEFAULT_AFFILIATE_SHARE,
  gatewayFeePayer = "MVEC",
}) {
  const gross = Number(grossTotal) || 0;
  const fee = cents(gatewayFee);
  const totalPlatformFee = cents((gross * (Number(commissionPercent) || 0)) / 100);
  const developerShare = cents((totalPlatformFee * (Number(developerSharePercent) || 0)) / 100);
  const platformAffiliateShare = hasAffiliate ? cents((totalPlatformFee * (Number(affiliateSharePercent) || 0)) / 100) : 0;
  const vendorAffiliateShare = hasAffiliate ? cents((gross * (Number(vendorAffiliatePercent) || 0)) / 100) : 0;
  const sellerPaysGateway = gatewayFeePayer === "SELLER";
  const adminShare = cents(Math.max(0, totalPlatformFee - developerShare - platformAffiliateShare - (sellerPaysGateway ? 0 : fee)));
  const vendorNet = cents(gross - totalPlatformFee - vendorAffiliateShare - (sellerPaysGateway ? fee : 0));

  return {
    vendorNet,
    totalPlatformFee,
    commissionPercent: Number(commissionPercent) || 0,
    gatewayFee: fee,
    gatewayFeePayer: sellerPaysGateway ? "SELLER" : "MVEC",
    developerShare,
    affiliateShare: cents(platformAffiliateShare + vendorAffiliateShare),
    platformAffiliateShare,
    vendorAffiliateShare,
    adminShare,
  };
}

module.exports = {
  DEFAULT_COMMISSION_PERCENT,
  DEFAULT_DEVELOPER_SHARE,
  DEFAULT_AFFILIATE_SHARE,
  GATEWAY_FEE_PAYERS,
  TOTAL_PLATFORM_FEE_PERCENT,
  DEVELOPER_PERCENT,
  AFFILIATE_PERCENT,
  computeRevenueSplit,
};
