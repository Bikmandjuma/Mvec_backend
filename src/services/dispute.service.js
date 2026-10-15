const mongoose = require("mongoose");
const Dispute = require("../models/Dispute");
const DisputeEvidence = require("../models/DisputeEvidence");
const Order = require("../models/Order");
const Settlement = require("../models/Settlement");
const { VendorBalance } = require("../models/Payout");
const VendorWallet = require("../models/VendorWallet");

class DisputeService {
  /**
   * Open a new dispute for an order
   */
  async openDispute({ orderId, raisedById, raisedByRole, reason, description, disputedAmount }) {
    if (!mongoose.isValidObjectId(orderId)) throw new Error("A valid order ID is required.");
    const order = await Order.findById(orderId);
    if (!order) throw new Error("Order not found.");
    if (raisedByRole !== "super_admin" && String(order.user) !== String(raisedById)) {
      throw new Error("Only the buyer of this order can open a dispute.");
    }
    if (order.paymentStatus !== "PAID") throw new Error("Disputes can only be opened on paid orders.");
    if (disputedAmount !== undefined && disputedAmount !== null && Number(disputedAmount) > Number(order.totalAmount)) {
      throw new Error("The disputed amount can't be more than the order total.");
    }

    const existing = await Dispute.findOne({ order: orderId, status: { $ne: "REJECTED" } });
    if (existing) {
      throw new Error(`Active dispute already exists for this order (${existing.disputeNumber}).`);
    }

    const disputeNumber = `DSP-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

    const dispute = await Dispute.create({
      disputeNumber,
      order: orderId,
      raisedBy: raisedById,
      vendor: order.items[0]?.vendor || order.vendor,
      reason,
      description,
      disputedAmount: disputedAmount || order.totalAmount,
      status: "OPEN",
    });

    // Freeze the order's escrow until MVEC arbitrates (delivery can't release it).
    await Settlement.updateMany(
      { order: order._id, status: "HELD" },
      { $set: { status: "ADMIN_HOLD", adminHoldReason: `Dispute ${disputeNumber}` } },
    );

    return dispute;
  }

  /**
   * Submit evidence files or chat message to a dispute
   */
  async submitEvidence({ disputeId, userId, userRole, message, attachments }) {
    const dispute = await Dispute.findById(disputeId);
    if (!dispute) throw new Error("Dispute not found.");

    if (["RESOLVED_BUYER_REFUNDED", "RESOLVED_VENDOR_RELEASED", "RESOLVED_SPLIT", "REJECTED"].includes(dispute.status)) {
      throw new Error("Cannot submit evidence to a closed dispute.");
    }

    const evidence = await DisputeEvidence.create({
      dispute: disputeId,
      submittedBy: userId,
      senderRole: userRole,
      message,
      attachments: attachments || [],
    });

    if (dispute.status === "OPEN") {
      dispute.status = "EVIDENCE_SUBMITTED";
      await dispute.save();
    }

    return evidence;
  }

  /**
   * Execute Binding Arbitration Decision (Super Admin Only)
   */
  async resolveDisputeArbitration({ disputeId, adminId, decision, buyerRefundAmount, vendorReleaseAmount, notes }) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const dispute = await Dispute.findById(disputeId).session(session);
      if (!dispute) throw new Error("Dispute not found.");

      if (dispute.status.startsWith("RESOLVED")) {
        throw new Error("Dispute has already been resolved.");
      }

      const order = await Order.findById(dispute.order).session(session);
      if (!order) throw new Error("Associated order not found.");
      if (!["REFUND_BUYER", "RELEASE_TO_VENDOR", "SPLIT_SETTLEMENT"].includes(decision)) {
        throw new Error("decision must be REFUND_BUYER, RELEASE_TO_VENDOR or SPLIT_SETTLEMENT.");
      }
      if (decision === "SPLIT_SETTLEMENT" && (Number(buyerRefundAmount) || 0) + (Number(vendorReleaseAmount) || 0) > Number(dispute.disputedAmount)) {
        throw new Error("Refund and release amounts can't exceed the disputed amount.");
      }

      let status = "RESOLVED_SPLIT";
      if (decision === "REFUND_BUYER") {
        status = "RESOLVED_BUYER_REFUNDED";
        order.paymentStatus = "REFUNDED";
      } else if (decision === "RELEASE_TO_VENDOR") {
        status = "RESOLVED_VENDOR_RELEASED";
        order.paymentStatus = "PAID";

        // Credit Vendor Wallet
        let wallet = await VendorWallet.findOne({ vendor: dispute.vendor }).session(session);
        if (!wallet) {
          wallet = new VendorWallet({ vendor: dispute.vendor, availableBalance: 0, pendingBalance: 0, totalEarned: 0 });
        }
        wallet.availableBalance += dispute.disputedAmount;
        wallet.totalEarned += dispute.disputedAmount;
        await wallet.save({ session });
      } else if (decision === "SPLIT_SETTLEMENT") {
        status = "RESOLVED_SPLIT";
        if (vendorReleaseAmount > 0) {
          let wallet = await VendorWallet.findOne({ vendor: dispute.vendor }).session(session);
          if (wallet) {
            wallet.availableBalance += vendorReleaseAmount;
            wallet.totalEarned += vendorReleaseAmount;
            await wallet.save({ session });
          }
        }
      }

      // Close the escrow frozen when the dispute was opened.
      const frozen = await Settlement.find({ order: order._id, status: "ADMIN_HOLD" }).session(session);
      for (const settlement of frozen) {
        settlement.status = decision === "REFUND_BUYER" ? "REFUNDED" : "RELEASED";
        if (settlement.status === "RELEASED") settlement.releasedAt = new Date();
        await settlement.save({ session });
        await VendorWallet.updateOne({ vendor: settlement.vendor }, { $inc: { pendingBalance: -Number(settlement.netAmount || 0) } }, { session });
      }
      await VendorWallet.updateMany({ pendingBalance: { $lt: 0 } }, { $set: { pendingBalance: 0 } }, { session });

      // Seller balance shown on the Payouts page.
      const released = decision === "RELEASE_TO_VENDOR" ? Number(dispute.disputedAmount) : decision === "SPLIT_SETTLEMENT" ? Number(vendorReleaseAmount) || 0 : 0;
      if (released > 0) {
        await VendorBalance.findOneAndUpdate(
          { vendor: dispute.vendor },
          { $inc: { availableBalance: released, totalEarned: released } },
          { upsert: true, session },
        );
      }

      dispute.status = status;
      dispute.arbitrationDecision = {
        decision,
        buyerRefundAmount: buyerRefundAmount || 0,
        vendorReleaseAmount: vendorReleaseAmount || 0,
        arbitratedBy: adminId,
        notes,
        decidedAt: new Date(),
      };

      await dispute.save({ session });
      await order.save({ session });

      await session.commitTransaction();
      session.endSession();

      return dispute;
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      throw error;
    }
  }
}

module.exports = new DisputeService();