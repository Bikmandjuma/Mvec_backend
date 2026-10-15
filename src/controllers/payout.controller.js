// src/controllers/payout.controller.js
const { Payout, VendorBalance } = require("../models/Payout");
const Order = require("../models/Order");
const { formatRwandanPhone } = require("../utils/momo.util");

const { TOTAL_PLATFORM_FEE_PERCENT } = require("../config/revenueSplit");

// Helper: Generate unique payout reference number
const generatePayoutNumber = () => `PAY-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

const sellerFinance = require("../services/sellerFinance.service");
const MIN_PAYOUT = 1000;

// @desc    Get Vendor Financial Balance Summary
// @route   GET /api/payouts/balance
// @access  Private (Vendor)
exports.getVendorBalance = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    let balance = await VendorBalance.findOne({ vendor: userId });
    if (!balance) {
      balance = await VendorBalance.create({ vendor: userId });
    }
    const live = await sellerFinance.summary(userId);
    const out = balance.toJSON ? balance.toJSON() : balance;
    // Escrow is worked out from the orders themselves so it can't drift.
    out.pendingBalance = live.inEscrow;
    return res.status(200).json({
      balance: out,
      summary: { ...live, available: Number(balance.availableBalance || 0), minimumPayout: MIN_PAYOUT },
      commissionRate: `${TOTAL_PLATFORM_FEE_PERCENT}%`,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Request a withdrawal. The amount is reserved from the available
//          balance and paid out by MVEC finance (admin) to mobile money.
// @route   POST /api/payouts/request
// @access  Private (Vendor)
exports.requestPayout = async (req, res) => {
  try {
    const { payoutMethod, payoutDetails } = req.body;
    const amount = Number(req.body.amount);
    const userId = req.user.id || req.user._id;

    if (!Number.isInteger(amount) || amount <= 0) {
      return res.status(400).json({ message: "Enter a whole amount in RWF." });
    }
    if (amount < MIN_PAYOUT) {
      return res.status(400).json({ message: `The minimum payout is ${MIN_PAYOUT.toLocaleString("en-RW")} RWF.` });
    }
    if (!payoutDetails || !String(payoutDetails.accountName || "").trim() || !payoutDetails.accountNumber) {
      return res.status(400).json({ message: "Enter the account name and mobile money number." });
    }

    // Format & validate Rwandan Phone Number for MOMO / AIRTEL
    const phoneInfo = formatRwandanPhone(payoutDetails.accountNumber);
    if (!phoneInfo) {
      return res.status(400).json({
        message: "Invalid Rwandan phone number. Must start with 078/079 (MTN) or 072/073 (Airtel).",
      });
    }
    const details = {
      accountName: String(payoutDetails.accountName).trim(),
      accountNumber: phoneInfo.formattedNumber,
      bankName: phoneInfo.provider === "MTN" ? "MTN MoMo" : "Airtel Money",
    };
    const method = payoutMethod || (phoneInfo.provider === "MTN" ? "MOMO" : "AIRTEL");

    // Reserve the amount atomically, so two requests can't spend the same money.
    const reserved = await VendorBalance.findOneAndUpdate(
      { vendor: userId, availableBalance: { $gte: amount } },
      { $inc: { availableBalance: -amount } },
      { new: true },
    );
    if (!reserved) {
      const balance = await VendorBalance.findOne({ vendor: userId });
      return res.status(400).json({ message: `Insufficient available balance. Available: ${Number(balance?.availableBalance || 0).toLocaleString("en-RW")} RWF.` });
    }

    let payout;
    try {
      payout = await Payout.create({
        vendor: userId,
        payoutNumber: generatePayoutNumber(),
        amount,
        payoutMethod: method,
        payoutDetails: details,
        status: "PENDING",
      });
    } catch (err) {
      await VendorBalance.updateOne({ vendor: userId }, { $inc: { availableBalance: amount } });
      throw err;
    }

    return res.status(201).json({
      message: `Payout request of ${amount.toLocaleString("en-RW")} RWF received. MVEC sends it to ${details.bankName} (${phoneInfo.localNumber}), usually within 1 business day.`,
      payout,
      updatedBalance: { availableBalance: reserved.availableBalance },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
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
    await VendorBalance.updateOne({ vendor: userId }, { $inc: { availableBalance: Number(payout.amount) } });
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