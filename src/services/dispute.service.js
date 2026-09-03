const mongoose = require("mongoose");
const Dispute = require("../models/Dispute");
const DisputeEvidence = require("../models/DisputeEvidence");
const Order = require("../models/Order");
const VendorWallet = require("../models/VendorWallet");

class DisputeService {
  /**
   * Open a new dispute for an order
   */
  async openDispute({ orderId, raisedById, reason, description, disputedAmount }) {
    const order = await Order.findById(orderId);
    if (!order) throw new Error("Order not found.");

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

    // Freeze order payment status to DISPUTED
    order.paymentStatus = "DISPUTED";
    await order.save();

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