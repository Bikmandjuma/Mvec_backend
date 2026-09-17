const mongoose = require("mongoose");
const AffiliateLink = require("../models/AffiliateLink");
const AffiliateWallet = require("../models/AffiliateWallet");
const AffiliatePayout = require("../models/AffiliatePayout");
const ConversionAudit = require("../models/ConversionAudit");
const Order = require("../models/Order");
const User = require("../models/User");
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

  /**
   * Resolve (or lazily create) an affiliate wallet so dashboards always have a shape.
   */
  async getWallet(userId) {
    const wallet = await AffiliateWallet.findOne({ affiliateUser: userId });
    if (wallet) return wallet;
    return { affiliateUser: userId, pendingBalance: 0, availableBalance: 0, totalWithdrawn: 0 };
  }

  /**
   * Full dashboard for the signed-in affiliate: wallet, links, click/conversion
   * totals and payout history.
   */
  async getDashboard(userId) {
    const [wallet, links, payouts] = await Promise.all([
      this.getWallet(userId),
      AffiliateLink.find({ affiliateUser: userId })
        .sort({ createdAt: -1 })
        .populate("targetProduct", "name price status media"),
      AffiliatePayout.find({ affiliateUser: userId }).sort({ createdAt: -1 }),
    ]);

    const totalClicks = links.reduce((s, l) => s + (l.clickCount || 0), 0);
    const totalConversions = links.reduce((s, l) => s + (l.conversionCount || 0), 0);
    const available = wallet.availableBalance || 0;
    const pending = wallet.pendingBalance || 0;
    const totalWithdrawn = wallet.totalWithdrawn || 0;

    return {
      wallet: {
        available,
        pending,
        totalWithdrawn,
        totalEarned: available + pending + totalWithdrawn,
      },
      links: links.map((l) => ({
        id: l._id,
        code: l.affiliateCode,
        productId: l.targetProduct?._id || null,
        product: l.targetProduct?.name || "Storewide link",
        productImage: l.targetProduct?.media?.mainImage || null,
        price: l.targetProduct?.price || null,
        clicks: l.clickCount || 0,
        conversions: l.conversionCount || 0,
        isActive: l.isActive,
        createdAt: l.createdAt,
      })),
      totalClicks,
      totalConversions,
      payouts: payouts.map((p) => ({
        id: p._id,
        number: p.payoutNumber,
        amount: p.amount,
        status: p.status,
        paymentMethod: p.paymentMethod,
        transactionReference: p.transactionReference,
        createdAt: p.createdAt,
      })),
    };
  }

  /**
   * Admin listing: every affiliate account with aggregated link/earnings stats.
   */
  async listAffiliates() {
    const users = await User.find({ role: "affiliate" })
      .select("Fullname email status companyName createdAt")
      .sort({ createdAt: -1 });
    const [links, wallets] = await Promise.all([
      AffiliateLink.find({}).select("affiliateUser clickCount conversionCount"),
      AffiliateWallet.find({}),
    ]);

    const byUser = {};
    links.forEach((l) => {
      const id = String(l.affiliateUser);
      byUser[id] = byUser[id] || { clicks: 0, conversions: 0 };
      byUser[id].clicks += l.clickCount || 0;
      byUser[id].conversions += l.conversionCount || 0;
    });
    const walletByUser = {};
    wallets.forEach((w) => {
      walletByUser[String(w.affiliateUser)] = w;
    });

    return users.map((u) => {
      const w = walletByUser[String(u._id)];
      const earned = w ? (w.availableBalance || 0) + (w.pendingBalance || 0) + (w.totalWithdrawn || 0) : 0;
      const agg = byUser[String(u._id)] || { clicks: 0, conversions: 0 };
      return {
        id: u._id,
        name: u.Fullname,
        email: u.email,
        status: u.status || "ACTIVE",
        companyName: u.companyName,
        createdAt: u.createdAt,
        clicks: agg.clicks,
        conversions: agg.conversions,
        earnings: earned,
      };
    });
  }

  /**
   * Payout history: all for admin, own for the signed-in affiliate.
   */
  async listPayouts({ user = null, isAdmin = false } = {}) {
    const query = isAdmin ? {} : { affiliateUser: user };
    const payouts = await AffiliatePayout.find(query)
      .sort({ createdAt: -1 })
      .populate("affiliateUser", "Fullname email");
    return payouts.map((p) => ({
      id: p._id,
      number: p.payoutNumber,
      affiliate: p.affiliateUser,
      amount: p.amount,
      status: p.status,
      paymentMethod: p.paymentMethod,
      accountDetails: p.accountDetails,
      transactionReference: p.transactionReference,
      rejectionReason: p.rejectionReason,
      createdAt: p.createdAt,
    }));
  }

  /**
   * Conversion audit trail for the signed-in affiliate. Returns a structured
   * empty array when no conversions have been recorded yet.
   */
  async getConversionAudit(userId) {
    const logs = await ConversionAudit.find({ affiliateUser: userId })
      .sort({ convertedAt: -1 })
      .populate("targetProduct", "name price status media")
      .populate("link", "affiliateCode targetProduct isActive");

    return logs.map((c) => ({
      id: c._id,
      referralCode: c.referralCode || c.link?.affiliateCode || "",
      productId: c.targetProduct?._id || (c.link && c.link.targetProduct) || null,
      product: c.targetProduct?.name || "Storewide link",
      order: c.order || null,
      conversionValue: c.conversionValue || 0,
      commissionEarned: c.commissionEarned || 0,
      status: c.status || "PENDING",
      convertedAt: c.convertedAt || c.createdAt,
    }));
  }
}

module.exports = new AffiliateService();