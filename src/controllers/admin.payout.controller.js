// MVEC's own money: what MVEC keeps from commissions builds up in one MVEC
// wallet (held until delivery, then available). MVEC does not send this money
// itself: an admin moves it from MVEC's payment-provider account (Paypack,
// Flutterwave, K-Pay) to the company bank, then records the withdrawal here
// so the books match.
const orm = require("../database/orm");
const ledger = require("../services/ledger.service");
const User = require("../models/User");
const AdminWallet = require("../models/AdminWallet");
const AdminPayout = require("../models/AdminPayout");

const generatePayoutNumber = () => `PAY-ADM-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

// The MVEC wallet is kept on the first admin account (the one escrow credits).
async function mvecWalletOwner() {
  const admin = await User.findOne({ role: "super_admin" }).sort({ createdAt: 1 }).select("_id").lean();
  return admin?._id;
}

// @route GET /api/admin/payouts/balance
exports.getAdminBalance = async (_req, res) => {
  try {
    const owner = await mvecWalletOwner();
    const wallet = (await AdminWallet.findOne({ adminUser: owner })) || { pendingBalance: 0, availableBalance: 0, totalEarned: 0, totalWithdrawn: 0 };
    return res.status(200).json({ wallet });
  } catch (error) {
    return res.status(500).json({ message: "Could not load MVEC's balance." });
  }
};

// @route POST /api/admin/payouts/request   { amount, destination, note }
// Records money an admin moved out of MVEC's provider account.
exports.requestAdminPayout = async (req, res) => {
  const amount = Math.round(Number(req.body.amount));
  const destination = String(req.body.destination || req.body.accountDetails?.accountNumber || "").trim().slice(0, 120);
  const note = String(req.body.note || "").trim().slice(0, 300);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: "Enter the amount you moved." });
  if (!destination) return res.status(400).json({ message: "Enter where the money went (bank account or number)." });
  const session = await orm.startSession();
  session.startTransaction();
  try {
    const owner = await mvecWalletOwner();
    const wallet = await AdminWallet.findOneAndUpdate(
      { adminUser: owner, availableBalance: { $gte: amount } },
      { $inc: { availableBalance: -amount, totalWithdrawn: amount } },
      { new: true, session },
    );
    if (!wallet) {
      await session.abortTransaction();
      const current = await AdminWallet.findOne({ adminUser: owner });
      return res.status(400).json({ message: `MVEC's available balance is ${Math.round(current?.availableBalance || 0).toLocaleString("en-RW")} RWF. Money is available once orders are delivered.` });
    }
    const [payout] = await AdminPayout.create([{
      payoutNumber: generatePayoutNumber(), adminUser: req.user._id || req.user.id, amount, paymentMethod: "BANK",
      accountDetails: { accountName: req.user.Fullname || "MVEC", accountNumber: destination, bankName: note || "Recorded withdrawal" },
      status: "PAID", processedAt: new Date(),
    }], { session });
    await ledger.payoutSent({ fromType: "PLATFORM_REVENUE", amount, reference: payout.payoutNumber, description: `MVEC withdrawal to ${destination}`, session });
    await session.commitTransaction();
    return res.status(201).json({
      message: `Recorded: ${amount.toLocaleString("en-RW")} RWF moved to ${destination}.`, payout, wallet,
      updatedBalance: { availableBalance: wallet.availableBalance, totalWithdrawn: wallet.totalWithdrawn },
    });
  } catch (error) {
    await session.abortTransaction().catch(() => {});
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Could not record the withdrawal." });
  } finally {
    session.endSession();
  }
};

// @route GET /api/admin/payouts/history — every recorded MVEC withdrawal.
exports.getAdminPayoutHistory = async (_req, res) => {
  try {
    const payouts = await AdminPayout.find({}).populate("adminUser", "Fullname").sort({ createdAt: -1 }).limit(100);
    return res.status(200).json({ payouts });
  } catch (error) {
    return res.status(500).json({ message: "Could not load the history." });
  }
};
