const orm = require("../database/orm");
const Settlement = require("../models/Settlement");
const LedgerEntry = require("../models/LedgerEntry");
const financialService = require("../services/financial.service");

// @desc    Get all financial ledger entries with pagination & filters (Auditing)
// @route   GET /api/admin/ledger
// @access  Private (Super Admin)
exports.getLedgerEntries = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 50));
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.entryType) {
      filter.entryType = req.query.entryType;
    }
    if (req.query.relatedOrder && orm.Types.ObjectId.isValid(req.query.relatedOrder)) {
      filter.relatedOrder = req.query.relatedOrder;
    }
    if (req.query.startDate || req.query.endDate) {
      filter.createdAt = {};
      if (req.query.startDate) {
        filter.createdAt.$gte = new Date(req.query.startDate);
      }
      if (req.query.endDate) {
        filter.createdAt.$lte = new Date(req.query.endDate);
      }
    }

    const [entries, total] = await Promise.all([
      LedgerEntry.find(filter)
        .populate("debitAccount creditAccount relatedOrder")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      LedgerEntry.countDocuments(filter),
    ]);

    // Where the money is right now: balance per account type (all sellers'
    // balances added together). Every entry moves money between two accounts,
    // so the balances always add up to zero.
    const LedgerAccount = require("../models/LedgerAccount");
    const accounts = await LedgerAccount.find({}).select("accountType balance").lean();
    const balances = {};
    for (const a of accounts) balances[a.accountType] = Math.round(((balances[a.accountType] || 0) + Number(a.balance || 0)) * 100) / 100;
    const check = Math.round(accounts.reduce((n, a) => n + Number(a.balance || 0), 0) * 100) / 100;
    return res.status(200).json({
      success: true,
      total,
      page,
      totalPages: Math.ceil(total / limit) || 1,
      count: entries.length,
      entries,
      balances,
      balanced: check === 0,
    });
  } catch (error) {
    console.error("Error fetching ledger entries:", error);
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Place Administrative Hold on Settlement
// @route   PATCH /api/admin/settlements/:id/hold
// @access  Private (Super Admin)
exports.placeAdminHold = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!orm.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid settlement ID format." });
    }

    const settlement = await Settlement.findById(id);
    if (!settlement) {
      return res.status(404).json({ message: "Settlement not found." });
    }

    if (settlement.status !== "HELD") {
      return res.status(400).json({
        message: `Cannot hold settlement with status: ${settlement.status}`,
      });
    }

    settlement.status = "ADMIN_HOLD";
    settlement.adminHoldReason = reason ? reason.trim() : "Administrative investigation pending";
    await settlement.save();

    return res.status(200).json({
      message: "Settlement placed on administrative hold.",
      settlement,
    });
  } catch (error) {
    console.error("Error placing admin hold:", error);
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Lift an administrative hold (the settlement is HELD again and can be
//          released by delivery confirmation or manually)
// @route   DELETE /api/admin/settlements/:id/hold   { note? }
// @access  Private (Super Admin)
exports.liftAdminHold = async (req, res) => {
  try {
    const { id } = req.params;
    if (!orm.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid settlement ID format." });
    }
    const settlement = await Settlement.findOneAndUpdate(
      { _id: id, status: "ADMIN_HOLD" },
      { $set: { status: "HELD", adminHoldReason: `${(req.body?.note || "Hold lifted").toString().trim().slice(0, 300)}` } },
      { new: true },
    );
    if (!settlement) {
      const exists = await Settlement.exists({ _id: id });
      return res.status(exists ? 400 : 404).json({ message: exists ? "This settlement is not on hold." : "Settlement not found." });
    }
    return res.status(200).json({ message: "Hold lifted. The settlement can be released again.", settlement });
  } catch (error) {
    console.error("Error lifting admin hold:", error);
    return res.status(500).json({ message: "We could not lift the hold right now. Please try again." });
  }
};

// @desc    Manual Escrow Release Override
// @route   POST /api/admin/settlements/:id/release
// @access  Private (Super Admin)
exports.manualEscrowRelease = async (req, res) => {
  const { id } = req.params;

  if (!orm.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Invalid settlement ID format." });
  }

  const session = await orm.startSession();
  session.startTransaction();

  try {
    const settlement = await financialService.releaseEscrowToVendor({
      settlementId: id,
      session,
      adminUserId: req.user?.id || req.user?._id || null,
    });

    await session.commitTransaction();
    session.endSession();

    return res.status(200).json({
      message: "Escrow funds manually released to vendor.",
      settlement,
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();

    // Differentiate between business rule validation error vs server crash
    const isClientError =
      error.message.includes("not eligible") ||
      error.message.includes("not found");
    const statusCode = isClientError ? 400 : 500;

    return res.status(statusCode).json({ message: error.message });
  }
};