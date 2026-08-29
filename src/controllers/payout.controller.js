const { Payout, VendorBalance } = require("../models/Payout");
const Order = require("../models/Order");

const DEFAULT_COMMISSION_RATE = 0.10; // 10% platform fee

// Helper: Generate unique payout reference number
const generatePayoutNumber = () => `PAY-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

// @desc    Get Vendor Financial Balance Summary
// @route   GET /api/payouts/balance
// @access  Private (Vendor)
exports.getVendorBalance = async (req, res) => {
  try {
    let balance = await VendorBalance.findOne({ vendor: req.user.id });
    if (!balance) {
      balance = await VendorBalance.create({ vendor: req.user.id });
    }
    return res.status(200).json({ balance, commissionRate: `${DEFAULT_COMMISSION_RATE * 100}%` });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Vendor requests a cash payout / withdrawal
// @route   POST /api/payouts/request
// @access  Private (Vendor)
exports.requestPayout = async (req, res) => {
  try {
    const { amount, payoutMethod, payoutDetails } = req.body;

    if (!amount || !payoutDetails || !payoutDetails.accountName || !payoutDetails.accountNumber) {
      return res.status(400).json({ message: "Amount and complete payout details are required." });
    }

    let balance = await VendorBalance.findOne({ vendor: req.user.id });
    if (!balance || balance.availableBalance < amount) {
      return res.status(400).json({
        message: `Insufficient available balance. Available: ${balance ? balance.availableBalance : 0}`,
      });
    }

    // Deduct requested amount from available balance
    balance.availableBalance -= amount;
    await balance.save();

    const payout = await Payout.create({
      vendor: req.user.id,
      payoutNumber: generatePayoutNumber(),
      amount,
      payoutMethod: payoutMethod || "MOBILE_MONEY",
      payoutDetails,
      status: "PENDING",
    });

    return res.status(201).json({ message: "Payout request submitted successfully", payout });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Get all payout requests for logged-in vendor
// @route   GET /api/payouts/history
// @access  Private (Vendor)
exports.getPayoutHistory = async (req, res) => {
  try {
    const payouts = await Payout.find({ vendor: req.user.id }).sort({ createdAt: -1 });
    return res.status(200).json({ payouts });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};


// @desc    Super Admin: Process / Approve / Reject Payout
// @route   PATCH /api/payouts/admin/:id/process
// @access  Private (Super Admin)
exports.processPayout = async (req, res) => {
  try {
    const { status, rejectionReason } = req.body;
    
    if (!["PAID", "REJECTED"].includes(status)) {
      return res.status(400).json({ message: "Status must be either PAID or REJECTED." });
    }

    const payout = await Payout.findById(req.params.id);
    if (!payout) {
      return res.status(404).json({ message: "Payout request not found." });
    }

    // TERMINAL STATE GUARD: Block any updates if already PAID or REJECTED
    if (payout.status === "PAID") {
      return res.status(400).json({ 
        message: "Action forbidden: This payout has already been completed (PAID) and cannot be altered." 
      });
    }

    if (payout.status === "REJECTED") {
      return res.status(400).json({ 
        message: "Action forbidden: This payout request has already been REJECTED." 
      });
    }

    const balance = await VendorBalance.findOne({ vendor: payout.vendor });

    if (status === "PAID") {
      payout.status = "PAID";
      payout.processedAt = new Date();
      
      if (balance) {
        balance.withdrawnAmount = (balance.withdrawnAmount || 0) + payout.amount;
        await balance.save();
      }
    } else if (status === "REJECTED") {
      payout.status = "REJECTED";
      payout.rejectionReason = rejectionReason || "Payout rejected by admin.";
      
      // Return money back to vendor's available balance
      if (balance) {
        balance.availableBalance = (balance.availableBalance || 0) + payout.amount;
        await balance.save();
      }
    }

    await payout.save();

    return res.status(200).json({ message: `Payout status updated to ${status}`, payout });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// Helper Service: Automatically calculate ledger updates when an order transitions to DELIVERED
exports.releaseOrderEarnings = async (orderId, vendorId) => {
  const order = await Order.findById(orderId);
  if (!order) return;

  // Filter items belonging to this vendor
  const vendorItems = order.items.filter(
    (item) => item.vendor && item.vendor.toString() === vendorId.toString()
  );

  // Calculate subtotal safely (fallback to item.price * item.quantity if itemTotal is missing)
  const itemSubtotal = vendorItems.reduce((acc, item) => {
    const total = item.itemTotal ?? (item.price * item.quantity) ?? 0;
    return acc + total;
  }, 0);

  const platformFee = itemSubtotal * DEFAULT_COMMISSION_RATE;
  const netEarnings = itemSubtotal - platformFee;

  let balance = await VendorBalance.findOne({ vendor: vendorId });
  if (!balance) {
    balance = await VendorBalance.create({ vendor: vendorId });
  }

  // Ensure initial values are clean numbers before adding
  balance.totalEarned = (balance.totalEarned || 0) + netEarnings;
  balance.commissionPaid = (balance.commissionPaid || 0) + platformFee;
  balance.availableBalance = (balance.availableBalance || 0) + netEarnings;

  await balance.save();
};