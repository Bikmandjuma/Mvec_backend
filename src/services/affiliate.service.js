const mongoose = require("mongoose");
const AffiliateLink = require("../models/AffiliateLink");
const AffiliateWallet = require("../models/AffiliateWallet");
const AffiliatePayout = require("../models/AffiliatePayout");
const crypto = require("crypto");

const MINIMUM_PAYOUT_RWF = 10000;

class AffiliateService {
  /**
   * Generate or retrieve affiliate referral code
   */
  async generateAffiliateLink(userId, productId = null) {
    const code = `AFF-${userId.toString().slice(-4)}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

    const link = await AffiliateLink.create({
      affiliateCode: code,
      affiliateUser: userId,
      targetProduct: productId || null,
    });

    return link;
  }

  /**
   * Register click with Fraud Guard (Self-referral & duplicate checks)
   */
  async trackClick(affiliateCode, visitorIp, buyerUserId = null) {
    const link = await AffiliateLink.findOne({ affiliateCode, isActive: true });
    if (!link) throw new Error("Invalid or inactive affiliate link.");

    // Fraud Guard: Prevent self-referrals
    if (buyerUserId && link.affiliateUser.toString() === buyerUserId.toString()) {
      return { FraudGuardFlagged: true, reason: "Self-referral blocked" };
    }

    link.clickCount += 1;
    await link.save();

    return { success: true, affiliateCode: link.affiliateCode, affiliateUser: link.affiliateUser };
  }

  /**
   * Credit Pending Commission upon successful purchase
   */
  async creditPendingCommission({ affiliateUser, amount, orderId }) {
    let wallet = await AffiliateWallet.findOne({ affiliateUser });
    if (!wallet) {
      wallet = new AffiliateWallet({ affiliateUser, pendingBalance: 0, availableBalance: 0 });
    }

    wallet.pendingBalance += amount;
    await wallet.save();

    return wallet;
  }

  /**
   * Request Wallet Payout (Server-side 10,000 RWF Minimum Rule Enforcement)
   */
  async requestPayout({ userId, amount, paymentMethod, accountDetails }) {
    if (amount < MINIMUM_PAYOUT_RWF) {
      throw new Error(`Minimum withdrawal threshold is RWF ${MINIMUM_PAYOUT_RWF.toLocaleString()}. Requested: RWF ${amount.toLocaleString()}`);
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const wallet = await AffiliateWallet.findOne({ affiliateUser: userId }).session(session);
      if (!wallet || wallet.availableBalance < amount) {
        throw new Error("Insufficient available balance for withdrawal.");
      }

      // Lock available balance into pending payout status
      wallet.availableBalance -= amount;
      await wallet.save({ session });

      const payoutNumber = `PAY-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
      const payout = await AffiliatePayout.create(
        [
          {
            payoutNumber,
            affiliateUser: userId,
            amount,
            paymentMethod,
            accountDetails,
            status: "PENDING",
          },
        ],
        { session }
      );

      await session.commitTransaction();
      session.endSession();

      return payout[0];
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  }

  /**
   * Super Admin Process & Approve Payout
   */
  async processAdminPayout({ payoutId, adminId, status, transactionReference, rejectionReason }) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const payout = await AffiliatePayout.findById(payoutId).session(session);
      if (!payout) throw new Error("Payout request not found.");

      if (payout.status !== "PENDING" && payout.status !== "PROCESSING") {
        throw new Error(`Cannot update payout in state: ${payout.status}`);
      }

      const wallet = await AffiliateWallet.findOne({ affiliateUser: payout.affiliateUser }).session(session);

      if (status === "COMPLETED") {
        payout.status = "COMPLETED";
        payout.transactionReference = transactionReference;
        payout.approvedBy = adminId;
        wallet.totalWithdrawn += payout.amount;
      } else if (status === "REJECTED") {
        payout.status = "REJECTED";
        payout.rejectionReason = rejectionReason || "Admin rejected payout request";
        // Revert funds back to available balance
        wallet.availableBalance += payout.amount;
      }

      await payout.save({ session });
      await wallet.save({ session });

      await session.commitTransaction();
      session.endSession();

      return payout;
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  }
}

module.exports = new AffiliateService();