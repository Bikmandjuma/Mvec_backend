const mongoose = require("mongoose");
const DeveloperWallet = require("../models/DeveloperWallet");
const DeveloperPayout = require("../models/DeveloperPayout");
const { formatRwandanPhone } = require("../utils/momo.util");

const generatePayoutNumber = () => `PAY-DEV-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

// @desc    Get Developer Wallet Balance
// @route   GET /api/developer/payouts/balance
// @access  Private (Developer)
exports.getDeveloperBalance = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    let wallet = await DeveloperWallet.findOne({ developerUser: userId });
    if (!wallet) {
      wallet = await DeveloperWallet.create({ developerUser: userId });
    }
    return res.status(200).json({ wallet });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Developer Payout / Withdrawal Request
// @route   POST /api/developer/payouts/request
// @access  Private (Developer)
exports.requestDeveloperPayout = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { amount, paymentMethod, accountDetails } = req.body;
    const userId = req.user.id || req.user._id;

    if (!amount || amount <= 0) {
      return res.status(400).json({ message: "Valid withdrawal amount is required." });
    }

    if (!accountDetails || !accountDetails.accountName || !accountDetails.accountNumber) {
      return res.status(400).json({ message: "Complete payout details (accountName, accountNumber) are required." });
    }

    const phoneInfo = formatRwandanPhone(accountDetails.accountNumber);
    if (!phoneInfo) {
      return res.status(400).json({
        message: "Invalid Rwandan phone number. Must start with 078/079 (MTN) or 073 (Airtel).",
      });
    }

    const determinedMethod = paymentMethod || (phoneInfo.provider === "MTN" ? "MOMO" : "AIRTEL");
    accountDetails.accountNumber = phoneInfo.formattedNumber;
    accountDetails.bankName = phoneInfo.provider === "MTN" ? "MTN MoMo" : "Airtel Money";

    let wallet = await DeveloperWallet.findOne({ developerUser: userId }).session(session);
    if (!wallet || wallet.availableBalance < amount) {
      return res.status(400).json({
        message: `Insufficient available balance. Available: ${wallet ? wallet.availableBalance : 0} RWF`,
      });
    }

    wallet.availableBalance -= amount;
    await wallet.save({ session });

    const payout = await DeveloperPayout.create(
      [
        {
          payoutNumber: generatePayoutNumber(),
          developerUser: userId,
          amount,
          paymentMethod: determinedMethod,
          accountDetails,
          status: "PAID",
          processedAt: new Date(),
        },
      ],
      { session }
    );

    wallet.totalWithdrawn = (wallet.totalWithdrawn || 0) + amount;
    await wallet.save({ session });

    await session.commitTransaction();
    session.endSession();

    return res.status(201).json({
      message: `Payout of ${amount} RWF disbursed to ${accountDetails.bankName} (${phoneInfo.localNumber}).`,
      payout: payout[0],
      updatedBalance: {
        availableBalance: wallet.availableBalance,
        totalWithdrawn: wallet.totalWithdrawn,
      },
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Get Developer Payout History
// @route   GET /api/developer/payouts/history
// @access  Private (Developer)
exports.getDeveloperPayoutHistory = async (req, res) => {
  try {
    const userId = req.user.id || req.user._id;
    const payouts = await DeveloperPayout.find({ developerUser: userId }).sort({ createdAt: -1 });
    return res.status(200).json({ payouts });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
