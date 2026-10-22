// The financial ledger: every movement of money is one entry that takes an
// amount FROM one account and puts it IN another, and both balances change in
// the same step. So the balances always add up, and each account tells a
// simple story:
//
//   BUYER_PAYMENTS     money buyers paid in (goes negative: total received)
//   ESCROW_HOLDING     money MVEC is holding until delivery
//   VENDOR_PAYABLE     a seller's / supplier's earned balance (one per owner)
//   PLATFORM_REVENUE   what MVEC earned (commission, ad clicks, subscriptions)
//   AFFILIATE_COMMISSION  affiliate commissions
//   GATEWAY_FEES       payment provider fees
//   AD_BUDGETS         ad budgets reserved from seller balances, not yet spent
//   BUYER_REFUND_HOLD  money refunded to buyers
//   PAID_OUT           money sent out to sellers, suppliers, affiliates or MVEC
//
// The real money sits in MVEC's payment provider account; this ledger says
// whose it is. BUYER_PAYMENTS minus refunds and payouts equals what that
// account should hold, so it can be checked against the provider's statement.
const LedgerAccount = require("../models/LedgerAccount");
const LedgerEntry = require("../models/LedgerEntry");

const LABELS = {
  BUYER_PAYMENTS: "Buyer payments",
  ESCROW_HOLDING: "MVEC holding",
  VENDOR_PAYABLE: "Seller balance",
  SUPPLIER_PAYABLE: "Supplier balance",
  PLATFORM_REVENUE: "MVEC revenue",
  ADMIN_REVENUE: "MVEC revenue",
  DEVELOPER_REVENUE: "MVEC revenue",
  AFFILIATE_COMMISSION: "Affiliate commission",
  GATEWAY_FEES: "Payment provider fees",
  AD_BUDGETS: "Ad budgets",
  BUYER_REFUND_HOLD: "Refunded to buyers",
  PAID_OUT: "Paid out",
  COURIER_PAYABLE: "Courier balance",
};

async function account(accountType, ownerId = null, session = null) {
  const query = { accountType, ownerId: ownerId ? String(ownerId) : null };
  let found = await LedgerAccount.findOne(query).session(session);
  if (!found) {
    const accountNumber = ownerId ? `ACC-${accountType}-${ownerId}` : `ACC-${accountType}-001`;
    found = (await LedgerAccount.create([{ accountNumber, accountType, ownerId: ownerId || null, balance: 0 }], { session }))[0];
  }
  return found;
}

/**
 * Move `amount` from one account to another and record it.
 * from / to: [accountType, ownerId?]. Amounts of 0 or less are ignored.
 */
async function post({ from, to, amount, entryType, order = null, reference, description, session = null }) {
  const value = Math.round(Number(amount) * 100) / 100;
  if (!(value > 0)) return null;
  const debit = await account(from[0], from[1], session);
  const credit = await account(to[0], to[1], session);
  await LedgerAccount.updateOne({ _id: debit._id }, { $inc: { balance: -value } }, { session });
  await LedgerAccount.updateOne({ _id: credit._id }, { $inc: { balance: value } }, { session });
  const [entry] = await LedgerEntry.create([{
    transactionReference: reference || `MVEC-TXN-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`,
    debitAccount: debit._id,
    creditAccount: credit._id,
    amount: value,
    entryType,
    relatedOrder: order || null,
    description: String(description || entryType).slice(0, 500),
  }], { session });
  return entry;
}

// Money sent out to its owner (withdrawal paid, MVEC withdrawal recorded).
const payoutSent = ({ fromType, ownerId = null, amount, reference, description, session = null }) =>
  post({ from: [fromType, ownerId], to: ["PAID_OUT"], amount, entryType: "PAYOUT_SENT", reference, description, session });

// The withdrawal was sent and then failed or was cancelled: money is back.
const payoutReturned = ({ toType, ownerId = null, amount, reference, description, session = null }) =>
  post({ from: ["PAID_OUT"], to: [toType, ownerId], amount, entryType: "ADMIN_MANUAL_ADJUSTMENT", reference, description, session });

// Money MVEC earns outside order commission (ad clicks, subscriptions): it
// becomes MVEC revenue in the ledger and is available in MVEC's wallet.
async function mvecEarned({ from, amount, entryType, reference, description, session = null }) {
  const value = Math.round(Number(amount) * 100) / 100;
  if (!(value > 0)) return null;
  const entry = await post({ from, to: ["PLATFORM_REVENUE"], amount: value, entryType, reference, description, session });
  const User = require("../models/User");
  const AdminWallet = require("../models/AdminWallet");
  const admin = await User.findOne({ role: "super_admin" }).sort({ createdAt: 1 }).select("_id").session(session);
  if (admin) {
    await AdminWallet.findOneAndUpdate(
      { adminUser: admin._id },
      { $inc: { availableBalance: value, totalEarned: value } },
      { upsert: true, session },
    );
  }
  return entry;
}

module.exports = { LABELS, account, post, payoutSent, payoutReturned, mvecEarned };
