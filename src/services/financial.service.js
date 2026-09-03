const mongoose = require("mongoose");
const LedgerAccount = require("../models/LedgerAccount");
const LedgerEntry = require("../models/LedgerEntry");
const Settlement = require("../models/Settlement");
const VendorWallet = require("../models/VendorWallet");

/**
 * 1. Locks incoming buyer payment into Escrow
 */
exports.lockPaymentInEscrow = async ({ orderId, vendorId, grossAmount, commissionAmount, session }) => {
  const netAmount = grossAmount - commissionAmount;

  // Fetch or create Escrow Holding Account
  let escrowAccount = await LedgerAccount.findOne({ accountType: "ESCROW_HOLDING" }).session(session);
  if (!escrowAccount) {
    escrowAccount = await LedgerAccount.create(
      [{ accountNumber: "ACC-ESCROW-001", accountType: "ESCROW_HOLDING", balance: 0 }],
      { session }
    ).then((res) => res[0]);
  }

  // Fetch or create Vendor Payable Account
  let vendorAccount = await LedgerAccount.findOne({ ownerId: vendorId, accountType: "VENDOR_PAYABLE" }).session(session);
  if (!vendorAccount) {
    vendorAccount = await LedgerAccount.create(
      [{ accountNumber: `ACC-VENDOR-${vendorId}`, accountType: "VENDOR_PAYABLE", ownerId: vendorId, balance: 0 }],
      { session }
    ).then((res) => res[0]);
  }

  // Update Account Balances
  escrowAccount.balance += grossAmount;
  await escrowAccount.save({ session });

  // Record Ledger Entry
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

  // Create Settlement Record
  const settlement = await Settlement.create(
    [
      {
        settlementReference: `MVEC-SETTLE-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
        order: orderId,
        vendor: vendorId,
        grossAmount,
        commissionAmount,
        netAmount,
        status: "HELD",
      },
    ],
    { session }
  );

  // Update Vendor Wallet Pending Balance
  await VendorWallet.findOneAndUpdate(
    { vendor: vendorId },
    { $inc: { pendingBalance: netAmount } },
    { upsert: true, session }
  );

  return settlement[0];
};

/**
 * 2. Releases Escrow Funds to Vendor upon OTP Delivery Confirmation or Super Admin Override
 */
exports.releaseEscrowToVendor = async ({ settlementId, session }) => {
  const settlement = await Settlement.findById(settlementId).session(session);
  if (!settlement) {
    throw new Error("Settlement not found.");
  }

  if (settlement.status !== "HELD") {
    throw new Error(`Settlement is not eligible for release with status: ${settlement.status}`);
  }

  let escrowAccount = await LedgerAccount.findOne({ accountType: "ESCROW_HOLDING" }).session(session);
  if (!escrowAccount) {
    escrowAccount = await LedgerAccount.create(
      [{ accountNumber: "ACC-ESCROW-001", accountType: "ESCROW_HOLDING", balance: 0 }],
      { session }
    ).then((res) => res[0]);
  }

  let vendorAccount = await LedgerAccount.findOne({ ownerId: settlement.vendor, accountType: "VENDOR_PAYABLE" }).session(session);
  if (!vendorAccount) {
    vendorAccount = await LedgerAccount.create(
      [{ accountNumber: `ACC-VENDOR-${settlement.vendor}`, accountType: "VENDOR_PAYABLE", ownerId: settlement.vendor, balance: 0 }],
      { session }
    ).then((res) => res[0]);
  }
  
  let platformAccount = await LedgerAccount.findOne({ accountType: "PLATFORM_REVENUE" }).session(session);
  if (!platformAccount) {
    platformAccount = await LedgerAccount.create(
      [{ accountNumber: "ACC-PLATFORM-REV", accountType: "PLATFORM_REVENUE", balance: 0 }],
      { session }
    ).then((res) => res[0]);
  }

  // Deduct from Escrow Account and credit Vendor & Platform
  escrowAccount.balance -= settlement.grossAmount;
  vendorAccount.balance += settlement.netAmount;
  platformAccount.balance += settlement.commissionAmount;

  await escrowAccount.save({ session });
  await vendorAccount.save({ session });
  await platformAccount.save({ session });

  // Update Settlement Status
  settlement.status = "RELEASED";
  settlement.releasedAt = new Date();
  await settlement.save({ session });

  // Record Double-Entry Ledger Releases
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

  // Update Vendor Wallet: Move Pending -> Available
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