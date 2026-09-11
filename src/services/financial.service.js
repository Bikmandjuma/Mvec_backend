const mongoose = require("mongoose");
const LedgerAccount = require("../models/LedgerAccount");
const LedgerEntry = require("../models/LedgerEntry");
const Settlement = require("../models/Settlement");
const VendorWallet = require("../models/VendorWallet");
const AdminWallet = require("../models/AdminWallet");
const DeveloperWallet = require("../models/DeveloperWallet");
const AffiliateWallet = require("../models/AffiliateWallet");
const User = require("../models/User");

async function getOrCreateLedgerAccount({ accountType, ownerId = null, session }) {
  const query = { accountType };
  if (ownerId) query.ownerId = ownerId;

  let account = await LedgerAccount.findOne(query).session(session);
  if (!account) {
    const accountNumber = ownerId
      ? `ACC-${accountType}-${ownerId}`
      : `ACC-${accountType}-001`;
    account = await LedgerAccount.create(
      [{ accountNumber, accountType, ownerId, balance: 0 }],
      { session }
    ).then((res) => res[0]);
  }
  return account;
}

async function findDefaultAdmin(session) {
  const admin = await User.findOne({ role: { $in: ["super_admin", "admin"] } })
    .session(session)
    .sort({ createdAt: 1 });
  return admin ? admin._id : null;
}

async function findDefaultDeveloper(session) {
  const dev = await User.findOne({ role: "developer" })
    .session(session)
    .sort({ createdAt: 1 });
  return dev ? dev._id : null;
}

exports.lockPaymentInEscrow = async ({
  orderId,
  vendorId,
  grossAmount,
  commissionAmount,
  session,
  split = null,
  affiliateUserId = null,
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
  const gwFee = split ? split.gatewayFee : 0;

  const escrowAccount = await getOrCreateLedgerAccount({ accountType: "ESCROW_HOLDING", session });
  const vendorAccount = await getOrCreateLedgerAccount({ accountType: "VENDOR_PAYABLE", ownerId: vendorId, session });

  escrowAccount.balance += grossAmount;
  await escrowAccount.save({ session });

  await LedgerEntry.create(
    [
      {
        transactionReference: `MVEC-TXN-${Date.now()}`,
        debitAccount: escrowAccount._id,
        creditAccount: vendorAccount._id,
        amount: grossAmount,
        entryType: "PAYMENT_ESCROW_LOCK",
        relatedOrder: orderId,
        description: `Escrow hold for Order #${orderId}`,
      },
    ],
    { session }
  );

  const adminUserId = adminShare > 0 ? await findDefaultAdmin(session) : null;

  const settlement = await Settlement.create(
    [
      {
        settlementReference: `MVEC-SETTLE-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
        order: orderId,
        vendor: vendorId,
        grossAmount,
        commissionAmount: platformFee,
        netAmount,
        developerShare: devShare,
        adminShare,
        affiliateShare: affShare,
        gatewayFee: gwFee,
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

  if (devShare > 0) {
    const developerUserId = await findDefaultDeveloper(session);
    if (developerUserId) {
      await DeveloperWallet.findOneAndUpdate(
        { developerUser: developerUserId },
        { $inc: { pendingBalance: devShare } },
        { upsert: true, session }
      );
    }
  }

  if (adminShare > 0 && adminUserId) {
    await AdminWallet.findOneAndUpdate(
      { adminUser: adminUserId },
      { $inc: { pendingBalance: adminShare } },
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

exports.releaseEscrowToVendor = async ({ settlementId, session, adminUserId = null }) => {
  const settlement = await Settlement.findById(settlementId).session(session);
  if (!settlement) {
    throw new Error("Settlement not found.");
  }

  if (settlement.status !== "HELD") {
    throw new Error(`Settlement is not eligible for release with status: ${settlement.status}`);
  }

  const escrowAccount = await getOrCreateLedgerAccount({ accountType: "ESCROW_HOLDING", session });
  const vendorAccount = await getOrCreateLedgerAccount({ accountType: "VENDOR_PAYABLE", ownerId: settlement.vendor, session });
  const platformAccount = await getOrCreateLedgerAccount({ accountType: "PLATFORM_REVENUE", session });

  const devShare = settlement.developerShare || 0;
  const adminShare = settlement.adminShare || 0;
  const affShare = settlement.affiliateShare || 0;
  const gwFee = settlement.gatewayFee || 0;

  escrowAccount.balance -= settlement.grossAmount;
  vendorAccount.balance += settlement.netAmount;
  platformAccount.balance += settlement.commissionAmount;

  await escrowAccount.save({ session });
  await vendorAccount.save({ session });
  await platformAccount.save({ session });

  if (devShare > 0) {
    const devAccount = await getOrCreateLedgerAccount({ accountType: "DEVELOPER_REVENUE", session });
    devAccount.balance += devShare;
    await devAccount.save({ session });

    const developerUserId = await findDefaultDeveloper(session);
    if (developerUserId) {
      await DeveloperWallet.findOneAndUpdate(
        { developerUser: developerUserId },
        {
          $inc: {
            pendingBalance: -devShare,
            availableBalance: devShare,
            totalEarned: devShare,
          },
        },
        { session }
      );
    }
  }

  if (adminShare > 0) {
    const adminAccount = await getOrCreateLedgerAccount({ accountType: "ADMIN_REVENUE", session });
    adminAccount.balance += adminShare;
    await adminAccount.save({ session });

    const targetAdminId = adminUserId || (await findDefaultAdmin(session));
    if (targetAdminId) {
      await AdminWallet.findOneAndUpdate(
        { adminUser: targetAdminId },
        {
          $inc: {
            pendingBalance: -adminShare,
            availableBalance: adminShare,
            totalEarned: adminShare,
          },
        },
        { session }
      );
    }
  }

  if (affShare > 0 && settlement.affiliateUser) {
    const affAccount = await getOrCreateLedgerAccount({ accountType: "AFFILIATE_COMMISSION", session });
    affAccount.balance += affShare;
    await affAccount.save({ session });

    await AffiliateWallet.findOneAndUpdate(
      { affiliateUser: settlement.affiliateUser },
      {
        $inc: {
          pendingBalance: -affShare,
          availableBalance: affShare,
        },
      },
      { session }
    );
  }

  if (gwFee > 0) {
    const gwAccount = await getOrCreateLedgerAccount({ accountType: "GATEWAY_FEES", session });
    gwAccount.balance += gwFee;
    await gwAccount.save({ session });
  }

  settlement.status = "RELEASED";
  settlement.releasedAt = new Date();
  await settlement.save({ session });

  await LedgerEntry.create(
    [
      {
        transactionReference: `MVEC-RELEASE-${Date.now()}`,
        debitAccount: escrowAccount._id,
        creditAccount: vendorAccount._id,
        amount: settlement.netAmount,
        entryType: "ESCROW_RELEASE_VENDOR",
        relatedOrder: settlement.order,
        description: `Net payout released to vendor for settlement ${settlement.settlementReference}`,
      },
      {
        transactionReference: `MVEC-COMM-${Date.now()}`,
        debitAccount: escrowAccount._id,
        creditAccount: platformAccount._id,
        amount: settlement.commissionAmount,
        entryType: "PLATFORM_COMMISSION_DEDUCTION",
        relatedOrder: settlement.order,
        description: `Platform commission deducted for settlement ${settlement.settlementReference}`,
      },
    ],
    { session }
  );

  await VendorWallet.findOneAndUpdate(
    { vendor: settlement.vendor },
    {
      $inc: {
        pendingBalance: -settlement.netAmount,
        availableBalance: settlement.netAmount,
        totalEarned: settlement.netAmount,
      },
    },
    { session }
  );

  return settlement;
};