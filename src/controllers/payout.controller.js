// src/controllers/payout.controller.js
const orm = require("../database/orm");
const { Payout, VendorBalance } = require("../models/Payout");
const VendorWallet = require("../models/VendorWallet");
const Settlement = require("../models/Settlement");
const disbursementService = require("../services/disbursement.service");
const sellerFinance = require("../services/sellerFinance.service");
const Order = require("../models/Order");
const { formatRwandanPhone } = require("../utils/momo.util");

const { TOTAL_PLATFORM_FEE_PERCENT } = require("../config/revenueSplit");

// Helper: Generate unique payout reference number
const generatePayoutNumber = () => `PAY-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

// The seller's money lives in VendorWallet: escrow releases credit it on
// delivery (financial.service). VendorBalance is the old, unused ledger.
const MIN_PAYOUT = 1000;
const walletOf = async (vendorId) =>
  (await VendorWallet.findOne({ vendor: vendorId })) || { pendingBalance: 0, availableBalance: 0, totalEarned: 0, totalWithdrawn: 0 };

// @desc    Get Vendor Financial Balance Summary
// @route   GET /api/payouts/balance
// @access  Private (Vendor)
exports.getVendorBalance = async (req, res) => {
  try {
    const vendorId = req.vendorId || req.targetVendorId || req.user.id;
    const [wallet, fees] = await Promise.all([
      walletOf(vendorId),
      Settlement.aggregate([
        { $match: { vendor: new orm.Types.ObjectId(String(vendorId)), status: "RELEASED" } },
        { $group: { _id: null, commission: { $sum: "$commissionAmount" } } },
      ]).catch(() => []),
    ]);
    const balance = {
      pendingBalance: wallet.pendingBalance || 0,
      availableBalance: wallet.availableBalance || 0,
      totalEarned: wallet.totalEarned || 0,
      totalWithdrawn: wallet.totalWithdrawn || 0,
      withdrawnAmount: wallet.totalWithdrawn || 0,
      commissionPaid: fees[0]?.commission || 0,
    };
    const rate = await require("../services/commission.service").resolveRate({ vendorId: req.vendorId || req.user._id || req.user.id, categoryId: null });
    return res.status(200).json({ balance, commissionRate: `${rate.percent}%` });
  } catch (error) {
    console.error("Vendor balance failed:", error);
    return res.status(500).json({ message: "We could not load your balance right now. Your money is safe; refresh in a moment." });
  }
};

// @desc    Withdraw available balance to mobile money
// @route   POST /api/payouts/request   { amount, payoutDetails: { accountName, accountNumber } }
// @access  Private (Vendor, staff with canManagePayouts)
exports.requestPayout = async (req, res) => {
  const vendorId = req.vendorId || req.targetVendorId || req.user.id;
  let reserved = 0;
  let payoutId = null;
  try {
    const amount = Math.round(Number(req.body.amount));
    const payoutDetails = req.body.payoutDetails || {};

    if (!Number.isFinite(amount) || amount < MIN_PAYOUT) {
      return res.status(400).json({ message: `Enter an amount of at least ${MIN_PAYOUT.toLocaleString("en-US")} RWF.` });
    }
    if (!String(payoutDetails.accountName || "").trim() || !payoutDetails.accountNumber) {
      return res.status(400).json({ message: "Enter the account holder's name and the mobile money number to pay." });
    }
    const phoneInfo = formatRwandanPhone(payoutDetails.accountNumber);
    if (!phoneInfo) {
      return res.status(400).json({ message: "Enter a Rwandan mobile money number: 078/079 (MTN) or 072/073 (Airtel)." });
    }
    const details = {
      accountName: String(payoutDetails.accountName).trim(),
      accountNumber: phoneInfo.formattedNumber,
      bankName: phoneInfo.provider === "MTN" ? "MTN MoMo" : "Airtel Money",
    };
    const method = payoutMethod || (phoneInfo.provider === "MTN" ? "MOMO" : "AIRTEL");

    // Reserve the money first; this fails if the balance is too low, even
    // when two withdrawals are sent at the same time.
    const wallet = await VendorWallet.findOneAndUpdate(
      { vendor: vendorId, availableBalance: { $gte: amount } },
      { $inc: { availableBalance: -amount } },
      { new: true },
    );
    if (!wallet) {
      const current = await walletOf(vendorId);
      return res.status(400).json({ message: `You can withdraw up to ${Number(current.availableBalance || 0).toLocaleString("en-US")} RWF right now. Money from an order becomes available once the buyer confirms delivery.` });
    }
    reserved = amount;

    const payout = await Payout.create({
      vendor: vendorId,
      payoutNumber: generatePayoutNumber(),
      amount,
      payoutMethod: phoneInfo.provider === "MTN" ? "MOMO" : "AIRTEL",
      payoutDetails: {
        accountName: String(payoutDetails.accountName).trim().slice(0, 100),
        accountNumber: phoneInfo.formattedNumber,
        bankName: phoneInfo.provider === "MTN" ? "MTN MoMo" : "Airtel Money",
      },
      status: "PROCESSING",
    });
    payoutId = payout._id;

    const transfer = await disbursementService.queue({
      kind: "VENDOR_PAYOUT",
      recipient: vendorId,
      phone: phoneInfo.formattedNumber,
      amount,
      vendorPayout: payout._id,
      idempotencyKey: `vendor-payout:${payout._id}`,
    });
    reserved = 0; // the disbursement service now owns the money and refunds it on final failure
    const fresh = await Payout.findById(payout._id);
    const sent = fresh?.status === "PAID";

    return res.status(201).json({
      message: sent
        ? `${amount.toLocaleString("en-US")} RWF was sent to ${phoneInfo.localNumber}.`
        : transfer?.status === "FAILED"
          ? `We could not reach the mobile money network yet. Your ${amount.toLocaleString("en-US")} RWF is reserved and we will retry automatically; if it still fails, it returns to your balance.`
          : `Your ${amount.toLocaleString("en-US")} RWF withdrawal to ${phoneInfo.localNumber} is on its way. You will get a notification when it arrives.`,
      payout: fresh || payout,
      updatedBalance: { availableBalance: wallet.availableBalance },
    });
  } catch (error) {
    if (reserved) {
      await VendorWallet.updateOne({ vendor: vendorId }, { $inc: { availableBalance: reserved } }).catch(() => {});
      if (payoutId) await Payout.updateOne({ _id: payoutId }, { $set: { status: "FAILED", rejectionReason: "Could not be started." } }).catch(() => {});
    }
    console.error("Vendor payout failed:", error);
    return res.status(500).json({ message: "Something went wrong on our side while starting your withdrawal. No money left your balance; please try again." });
  }
};

// @desc    Cancel a payout request that hasn't been processed yet
// @route   POST /api/payouts/:id/cancel
// @access  Private (Vendor)
exports.cancelPayout = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const payout = await Payout.findOneAndUpdate(
      { _id: req.params.id, vendor: userId, status: "PENDING" },
      { $set: { status: "CANCELLED", rejectionReason: "Cancelled by the seller", processedAt: new Date() } },
      { new: true },
    );
    if (!payout) return res.status(400).json({ message: "Only pending payout requests can be cancelled." });
    await VendorWallet.updateOne({ vendor: userId }, { $inc: { availableBalance: Number(payout.amount) } });
    return res.status(200).json({ message: "Payout request cancelled. The amount is back in your available balance.", payout });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Seller statement: sales, payouts, charges and dispute releases
// @route   GET /api/payouts/statement?from=YYYY-MM-DD&to=YYYY-MM-DD
// @access  Private (Vendor)
exports.getStatement = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const entries = await sellerFinance.statement(userId, { from: req.query.from, to: req.query.to });
    const totals = {
      released: entries.filter((e) => e.type === "SALE" && e.state === "RELEASED").reduce((t, e) => t + e.net, 0),
      commission: entries.filter((e) => e.type === "SALE" && ["RELEASED", "ARBITRATED"].includes(e.state)).reduce((t, e) => t + e.commission, 0),
      paidOut: entries.filter((e) => e.type === "PAYOUT" && e.state === "PAID").reduce((t, e) => t - e.net, 0),
      charges: entries.filter((e) => !["SALE", "PAYOUT", "DISPUTE_RELEASE"].includes(e.type) && e.state === "CHARGED").reduce((t, e) => t - e.net, 0),
    };
    return res.status(200).json({ entries, totals });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Get all payout requests for logged-in vendor
// @route   GET /api/payouts/history
// @access  Private (Vendor)
exports.getPayoutHistory = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const payouts = await Payout.find({ vendor: userId }).sort({ createdAt: -1 });
    return res.status(200).json({ payouts });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Helper Service: Automatically credit pending balance when an order is PAID
exports.creditPendingEarnings = async (orderId, vendorId) => {
  const order = await Order.findById(orderId);
  if (!order) return;

  const vendorItems = order.items.filter(
    (item) => item.vendor && item.vendor.toString() === vendorId.toString()
  );

  const itemSubtotal = vendorItems.reduce((acc, item) => {
    const total = item.itemTotal ?? (item.price * item.quantity) ?? 0;
    return acc + total;
  }, 0);

  const platformFee = (itemSubtotal * TOTAL_PLATFORM_FEE_PERCENT) / 100;
  const netEarnings = itemSubtotal - platformFee;

  let balance = await VendorBalance.findOne({ vendor: vendorId });
  if (!balance) {
    balance = await VendorBalance.create({ vendor: vendorId });
  }

  balance.pendingBalance = (balance.pendingBalance || 0) + netEarnings;
  await balance.save();
};

// Helper Service: Transition pending funds to available balance upon DELIVERED status
exports.releaseOrderEarnings = async (orderId, vendorId) => {
  const order = await Order.findById(orderId);
  if (!order) return;
  // The seller collected this money directly (paid offline, or cash on delivery
  // for an order they recorded themselves); nothing passed through MVEC.
  if (order.paidOffline || (order.source === "MANUAL" && order.paymentMethod === "CASH_ON_DELIVERY")) return;

  const vendorItems = order.items.filter(
    (item) => item.vendor && item.vendor.toString() === vendorId.toString()
  );

  const itemSubtotal = vendorItems.reduce((acc, item) => {
    const total = item.itemTotal ?? (item.price * item.quantity) ?? 0;
    return acc + total;
  }, 0);

  const platformFee = (itemSubtotal * TOTAL_PLATFORM_FEE_PERCENT) / 100;
  // Delivery fees for this seller's parcels are paid out in full (no commission).
  const shippingFee = (order.shippingBreakdown || [])
    .filter((s) => s.vendor && s.vendor.toString() === vendorId.toString())
    .reduce((sum, s) => sum + (s.fee || 0), 0);
  const netEarnings = itemSubtotal - platformFee + shippingFee;

  let balance = await VendorBalance.findOne({ vendor: vendorId });
  if (!balance) {
    balance = await VendorBalance.create({ vendor: vendorId });
  }

  if (balance.pendingBalance >= netEarnings) {
    balance.pendingBalance -= netEarnings;
  } else {
    balance.pendingBalance = 0;
  }

  balance.totalEarned = (balance.totalEarned || 0) + netEarnings;
  balance.commissionPaid = (balance.commissionPaid || 0) + platformFee;
  balance.availableBalance = (balance.availableBalance || 0) + netEarnings;

  await balance.save();
};