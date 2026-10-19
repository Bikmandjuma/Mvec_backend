const orm = require("../database/orm");
const Settlement = require("../models/Settlement");
const VendorWallet = require("../models/VendorWallet");
const AdminWallet = require("../models/AdminWallet");
const AffiliateWallet = require("../models/AffiliateWallet");
const User = require("../models/User");
const Order = require("../models/Order");
const ConversionAudit = require("../models/ConversionAudit");
const ledger = require("./ledger.service");

async function findDefaultAdmin(session) {
  const admin = await User.findOne({ role: { $in: ["super_admin", "admin"] } })
    .session(session)
    .sort({ createdAt: 1 });
  return admin ? admin._id : null;
}

exports.lockPaymentInEscrow = async ({
  orderId,
  vendorId,
  grossAmount,
  commissionAmount,
  session,
  split = null,
  affiliateUserId = null,
  orderItemId = null,
}) => {
  const platformFee = split
    ? Number(split.totalPlatformFee) || Number(split.commissionAmount) || 0
    : Number(commissionAmount) || 0;
  const netAmount = split
    ? Number(split.vendorNet) || Number(split.vendorNetEarnings) || grossAmount - platformFee
    : grossAmount - commissionAmount;
  const devShare = split ? split.developerShare : 0;
  const adminShare = split ? split.adminShare : 0;
  const affShare = split ? split.affiliateShare : 0;
  const vendorAffShare = split ? Number(split.vendorAffiliateShare) || 0 : 0;
  const gwFee = split ? split.gatewayFee : 0;

  // The buyer's money is now held by MVEC until delivery.
  await ledger.post({
    from: ["BUYER_PAYMENTS"], to: ["ESCROW_HOLDING"], amount: grossAmount, entryType: "PAYMENT_RECEIVED",
    order: orderId, description: `Buyer payment held until delivery (order ${orderId})`, session,
  });

  // MVEC's share includes the developer share: it belongs to the platform.
  const platformShare = (Number(adminShare) || 0) + (Number(devShare) || 0);
  const adminUserId = platformShare > 0 ? await findDefaultAdmin(session) : null;
  const settlement = await Settlement.create(
    [
      {
        settlementReference: `MVEC-SETTLE-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
        order: orderId,
        orderItemId,
        vendor: vendorId,
        grossAmount,
        commissionAmount: platformFee,
        netAmount,
        developerShare: devShare,
        adminShare,
        affiliateShare: affShare,
        vendorAffiliateShare: vendorAffShare,
        gatewayFee: gwFee,
        commissionRate: split ? Number(split.commissionRate ?? split.commissionRateValue) || null : null,
        gatewayFeePayer: split?.gatewayFeePayer === "SELLER" ? "SELLER" : "MVEC",
        affiliateUser: affiliateUserId,
        status: "HELD",
      },
    ],
    { session }
  );

  await VendorWallet.findOneAndUpdate(
    { vendor: vendorId },
    { $inc: { pendingBalance: netAmount } },
    { upsert: true, session }
  );

  if (platformShare > 0 && adminUserId) {
    await AdminWallet.findOneAndUpdate(
      { adminUser: adminUserId },
      { $inc: { pendingBalance: platformShare } },
      { upsert: true, session }
    );
  }

  if (affShare > 0 && affiliateUserId) {
    await AffiliateWallet.findOneAndUpdate(
      { affiliateUser: affiliateUserId },
      { $inc: { pendingBalance: affShare } },
      { upsert: true, session }
    );
  }

  return settlement[0];
};

/**
 * The single place affiliate commissions become APPROVED.
 *
 * Preconditions are read from the order itself: it must be PAID and have been
 * confirmed DELIVERED/COMPLETED. Anything else (shipped, processing, cancelled,
 * refunded, unpaid) leaves commissions untouched. The PENDING -> APPROVED flip
 * is an atomic conditional update, so replays and concurrent events can never
 * approve (or credit the wallet) twice; reversed commissions are no longer
 * PENDING and are skipped. Delivery is tracked per order, so all promoted items
 * of the order are approved together, each for its net (post-refund) amount.
 */
exports.approveAffiliateCommissionsForOrder = async ({ orderId, session }) => {
  const order = await Order.findById(orderId).session(session);
  if (!order) return [];
  const delivered = order.isDelivered && ["DELIVERED", "COMPLETED"].includes(order.orderStatus);
  if (order.paymentStatus !== "PAID" || !delivered) return [];

  const pending = await ConversionAudit.find({ order: order._id, status: "PENDING" }).session(session);
  const approved = [];
  for (const audit of pending) {
    const claimed = await ConversionAudit.findOneAndUpdate(
      { _id: audit._id, status: "PENDING" },
      { $set: { status: "APPROVED", approvedAt: new Date() } },
      { new: true, session }
    );
    if (!claimed) continue;

    const net = Math.round((claimed.commissionEarned - claimed.reversedAmount) * 100) / 100;
    if (net > 0) {
      // The ledger already moved the commission at escrow release; here the
      // affiliate's wallet makes it withdrawable.
      await AffiliateWallet.findOneAndUpdate(
        { affiliateUser: claimed.affiliateUser },
        { $inc: { pendingBalance: -net, availableBalance: net } },
        { session }
      );
    }
    approved.push({ audit: claimed._id, amount: net });
  }
  return approved;
};

exports.releaseEscrowToVendor = async ({ settlementId, session, adminUserId = null }) => {
  const settlement = await Settlement.findById(settlementId).session(session);
  if (!settlement) {
    throw new Error("Settlement not found.");
  }

  // An admin hold blocks every release until the hold is lifted.
  if (settlement.status !== "HELD") {
    throw new Error(settlement.status === "ADMIN_HOLD"
      ? "Settlement is not eligible for release while on admin hold. Lift the hold first."
      : `Settlement is not eligible for release with status: ${settlement.status}`);
  }

  const gross = Number(settlement.grossAmount) || 0;
  const net = Number(settlement.netAmount) || 0;
  const affiliates = Number(settlement.affiliateShare) || 0; // MVEC-paid + seller-paid
  const gwFee = Number(settlement.gatewayFee) || 0;
  // What MVEC keeps: everything that is not the seller's, the affiliates' or the provider's.
  const platformShare = Math.round((gross - net - affiliates - gwFee) * 100) / 100;
  const ref = settlement.settlementReference;
  const common = { order: settlement.order, session };

  // The held money leaves MVEC holding to its rightful owners; holding returns to zero.
  await ledger.post({ ...common, from: ["ESCROW_HOLDING"], to: ["VENDOR_PAYABLE", settlement.vendor], amount: net, entryType: "ESCROW_RELEASE_VENDOR", description: `Seller's share released (${ref})` });
  await ledger.post({ ...common, from: ["ESCROW_HOLDING"], to: ["PLATFORM_REVENUE"], amount: platformShare, entryType: "PLATFORM_COMMISSION_DEDUCTION", description: `MVEC commission (${ref})` });
  await ledger.post({ ...common, from: ["ESCROW_HOLDING"], to: ["AFFILIATE_COMMISSION"], amount: affiliates, entryType: "AFFILIATE_COMMISSION", description: `Affiliate commission (${ref})` });
  await ledger.post({ ...common, from: ["ESCROW_HOLDING"], to: ["GATEWAY_FEES"], amount: gwFee, entryType: "GATEWAY_FEE", description: `Payment provider fee (${ref})` });

  // MVEC's wallet: its share (developer share included) becomes available.
  const walletShare = (Number(settlement.adminShare) || 0) + (Number(settlement.developerShare) || 0);
  const targetAdminId = walletShare > 0 ? adminUserId || (await findDefaultAdmin(session)) : null;
  if (targetAdminId) {
    await AdminWallet.findOneAndUpdate(
      { adminUser: targetAdminId },
      { $inc: { pendingBalance: -walletShare, availableBalance: walletShare, totalEarned: walletShare } },
      { upsert: true, session }
    );
  }

  // Affiliate commission is approved by delivery, not by escrow release alone;
  // this is a no-op unless the order is already delivered.
  if (Number(settlement.affiliateShare) > 0 && settlement.affiliateUser) {
    await exports.approveAffiliateCommissionsForOrder({ orderId: settlement.order, session });
  }

  settlement.status = "RELEASED";
  settlement.releasedAt = new Date();
  await settlement.save({ session });

  await VendorWallet.findOneAndUpdate(
    { vendor: settlement.vendor },
    { $inc: { pendingBalance: -net, availableBalance: net, totalEarned: net } },
    { session }
  );

  return settlement;
};

/**
 * Reverse every HELD settlement of an order after a paid order is cancelled
 * or refunded. Undoes exactly what lockPaymentInEscrow recorded: the held
 * money goes to "Refunded to buyers", the pending wallet balances are removed
 * and the settlement is marked REFUNDED. Released settlements are never touched.
 */
exports.refundHeldEscrowForOrder = async ({ orderId, session }) => {
  const settlements = await Settlement.find({ order: orderId, status: "HELD" }).session(session);
  if (!settlements.length) return [];

  const adminUserId = settlements.some((s) => Number(s.adminShare) + Number(s.developerShare) > 0) ? await findDefaultAdmin(session) : null;

  for (const settlement of settlements) {
    await ledger.post({
      from: ["ESCROW_HOLDING"], to: ["BUYER_REFUND_HOLD"], amount: settlement.grossAmount, entryType: "BUYER_REFUND",
      order: orderId, description: `Refunded to the buyer (${settlement.settlementReference})`, session,
    });

    await VendorWallet.updateOne(
      { vendor: settlement.vendor },
      { $inc: { pendingBalance: -settlement.netAmount } },
      { session }
    );
    const platformShare = (Number(settlement.adminShare) || 0) + (Number(settlement.developerShare) || 0);
    if (platformShare > 0 && adminUserId) {
      await AdminWallet.updateOne(
        { adminUser: adminUserId },
        { $inc: { pendingBalance: -platformShare } },
        { session }
      );
    }
    if (settlement.affiliateShare > 0 && settlement.affiliateUser) {
      await AffiliateWallet.updateOne(
        { affiliateUser: settlement.affiliateUser },
        { $inc: { pendingBalance: -settlement.affiliateShare } },
        { session }
      );
    }

    settlement.status = "REFUNDED";
    await settlement.save({ session });
  }

  return settlements;
};

/**
 * Dispute decided with a split: part of the held money goes back to the
 * buyer, part to the seller, and anything left stays with MVEC. Each held
 * settlement of the order takes its proportional part, is updated to what
 * really happened and closed, so it can never be released again on delivery.
 */
exports.splitHeldEscrowForOrder = async ({ orderId, buyerRefund = 0, sellerRelease = 0, session, adminUserId = null }) => {
  const settlements = await Settlement.find({ order: orderId, status: "HELD" }).session(session);
  const held = settlements.reduce((s, x) => s + (Number(x.grossAmount) || 0), 0);
  if (!settlements.length || !(held > 0)) return [];
  const refundTotal = Math.min(Math.max(0, Number(buyerRefund) || 0), held);
  const releaseTotal = Math.min(Math.max(0, Number(sellerRelease) || 0), held - refundTotal);
  const round = (v) => Math.round(v * 100) / 100;
  const adminId = adminUserId || (await findDefaultAdmin(session));

  let refundLeft = refundTotal;
  let releaseLeft = releaseTotal;
  for (const [i, settlement] of settlements.entries()) {
    const gross = Number(settlement.grossAmount) || 0;
    const last = i === settlements.length - 1;
    const refund = last ? refundLeft : round((refundTotal * gross) / held);
    const release = last ? releaseLeft : round((releaseTotal * gross) / held);
    const keep = round(gross - refund - release);
    refundLeft = round(refundLeft - refund);
    releaseLeft = round(releaseLeft - release);
    const ref = settlement.settlementReference;
    const common = { order: orderId, session };

    await ledger.post({ ...common, from: ["ESCROW_HOLDING"], to: ["BUYER_REFUND_HOLD"], amount: refund, entryType: "BUYER_REFUND", description: `Dispute split: refunded to the buyer (${ref})` });
    await ledger.post({ ...common, from: ["ESCROW_HOLDING"], to: ["VENDOR_PAYABLE", settlement.vendor], amount: release, entryType: "ESCROW_RELEASE_VENDOR", description: `Dispute split: released to the seller (${ref})` });
    await ledger.post({ ...common, from: ["ESCROW_HOLDING"], to: ["PLATFORM_REVENUE"], amount: keep, entryType: "PLATFORM_COMMISSION_DEDUCTION", description: `Dispute split: kept by MVEC (${ref})` });

    // Wallets: remove what was pending, add what was actually paid.
    await VendorWallet.updateOne(
      { vendor: settlement.vendor },
      { $inc: { pendingBalance: -(Number(settlement.netAmount) || 0), availableBalance: release, totalEarned: release } },
      { session }
    );
    const platformPending = (Number(settlement.adminShare) || 0) + (Number(settlement.developerShare) || 0);
    if (adminId && (platformPending > 0 || keep > 0)) {
      await AdminWallet.findOneAndUpdate(
        { adminUser: adminId },
        { $inc: { pendingBalance: -platformPending, availableBalance: keep, totalEarned: keep } },
        { upsert: true, session }
      );
    }
    if (Number(settlement.affiliateShare) > 0 && settlement.affiliateUser) {
      await AffiliateWallet.updateOne(
        { affiliateUser: settlement.affiliateUser },
        { $inc: { pendingBalance: -Number(settlement.affiliateShare) } },
        { session }
      );
    }

    // The settlement now records what really happened.
    Object.assign(settlement, {
      netAmount: release, commissionAmount: keep, adminShare: keep, developerShare: 0,
      affiliateShare: 0, vendorAffiliateShare: 0, gatewayFee: 0,
      status: release + keep > 0 ? "RELEASED" : "REFUNDED", releasedAt: new Date(),
    });
    await settlement.save({ session });
  }
  return settlements;
};
