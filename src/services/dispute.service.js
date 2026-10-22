const orm = require("../database/orm");
const Dispute = require("../models/Dispute");
const DisputeEvidence = require("../models/DisputeEvidence");
const Order = require("../models/Order");
const VendorWallet = require("../models/VendorWallet");
const affiliateAttribution = require("./affiliateAttribution.service");

class DisputeService {
  /**
   * Open a new dispute for an order
   */
  async openDispute({ orderId, raisedById, reason, description, disputedAmount }) {
    if (!orm.isValidObjectId(orderId)) throw new Error("A valid order ID is required.");
    const order = await Order.findById(orderId);
    // Only the buyer who placed the order can open a dispute on it.
    if (!order || String(order.user) !== String(raisedById)) throw new Error("Order not found.");
    if (order.paymentStatus !== "PAID") {
      throw new Error("You can report a problem once the order has been paid.");
    }
    const allowedReasons = ["ITEM_NOT_RECEIVED", "WRONG_ITEM", "DAMAGED_GOODS", "INCOMPLETE_ORDER", "OTHER"];
    if (!allowedReasons.includes(reason)) throw new Error("Please choose what went wrong.");
    if (typeof description !== "string" || description.trim().length < 10) {
      throw new Error("Please describe the problem in at least 10 characters.");
    }
    const amount = Number(disputedAmount);
    const safeAmount = Number.isFinite(amount) && amount > 0 ? Math.min(amount, order.totalAmount) : order.totalAmount;

    const existing = await Dispute.findOne({ order: orderId, status: { $nin: ["REJECTED", "WITHDRAWN", "RESOLVED_BUYER_REFUNDED", "RESOLVED_VENDOR_RELEASED", "RESOLVED_SPLIT"] } });
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
      description: description.trim().slice(0, 2000),
      disputedAmount: safeAmount,
      status: "OPEN",
      // The seller's deadline to respond before MVEC steps in (admin setting).
      respondBy: new Date(Date.now() + (Number((await require("./platformSettings.service").get()).disputeResponseDays) || 3) * 24 * 60 * 60 * 1000),
    });
    await DisputeEvidence.create({ dispute: dispute._id, submittedBy: raisedById, senderRole: "system", message: "The buyer reported a problem. The payment is on hold until it's resolved.", attachments: [] });

    // Freeze order payment status to DISPUTED
    order.paymentStatus = "DISPUTED";
    await order.save();
    require("./notification.service").disputeOpened(order, dispute).catch(() => {});

    return dispute;
  }

  /**
   * Submit evidence files or chat message to a dispute
   */
  async submitEvidence({ disputeId, userId, userRole, message, attachments }) {
    const dispute = await Dispute.findById(disputeId);
    if (!dispute) throw new Error("Dispute not found.");

    // Only the buyer who raised it, every seller on the order and MVEC admins take part.
    const order = await Order.findById(dispute.order);
    const sellers = new Set([String(dispute.vendor), ...(order?.items || []).filter((i) => i.vendor).map((i) => String(i.vendor._id || i.vendor))]);
    const isParty = String(dispute.raisedBy) === String(userId) || sellers.has(String(userId)) || userRole === "super_admin";
    if (!isParty) throw Object.assign(new Error("Dispute not found."), { statusCode: 404 });

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

    // The seller has responded once they reply (a buyer adding detail doesn't count).
    if (dispute.status === "OPEN" && userRole !== "buyer" && String(userId) !== String(dispute.raisedBy)) {
      dispute.status = "EVIDENCE_SUBMITTED";
      await dispute.save();
    }
    if (order) {
      require("./notification.service").disputeReply(order, dispute, { fromUserId: userId, fromRole: userRole }).catch(() => {});
    }

    return evidence;
  }

  /**
   * Execute Binding Arbitration Decision (Super Admin Only)
   */
  async resolveDisputeArbitration({ disputeId, adminId, decision, buyerRefundAmount, vendorReleaseAmount, notes }) {
    let refundPayment = null;
    let refundAmount = 0;
    const session = await orm.startSession();
    session.startTransaction();

    try {
      const dispute = await Dispute.findById(disputeId).session(session);
      if (!dispute) throw new Error("Dispute not found.");

      if (dispute.status.startsWith("RESOLVED") || ["WITHDRAWN", "REJECTED"].includes(dispute.status)) {
        throw new Error("This case is already closed.");
      }

      const order = await Order.findById(dispute.order).session(session);
      if (!order) throw new Error("Associated order not found.");
      if (!["REFUND_BUYER", "RELEASE_TO_VENDOR", "SPLIT_SETTLEMENT"].includes(decision)) {
        throw new Error("decision must be REFUND_BUYER, RELEASE_TO_VENDOR or SPLIT_SETTLEMENT.");
      }
      if (decision === "SPLIT_SETTLEMENT" && (Number(buyerRefundAmount) || 0) + (Number(vendorReleaseAmount) || 0) > Number(order.totalAmount)) {
        throw new Error("The refund and release together cannot exceed the order total.");
      }

      if (!["REFUND_BUYER", "RELEASE_TO_VENDOR", "SPLIT_SETTLEMENT"].includes(decision)) {
        throw new Error("Choose refund buyer, release to vendor or split.");
      }
      buyerRefundAmount = Math.max(0, Number(buyerRefundAmount) || 0);
      vendorReleaseAmount = Math.max(0, Number(vendorReleaseAmount) || 0);
      if (decision === "SPLIT_SETTLEMENT" && buyerRefundAmount + vendorReleaseAmount > order.totalAmount) {
        throw new Error("The refund and release together cannot exceed the order total.");
      }
      const financialService = require("./financial.service");
      const Payment = require("../models/Payment");
      const Settlement = require("../models/Settlement");

      let status = "RESOLVED_SPLIT";
      if (decision === "REFUND_BUYER") {
        status = "RESOLVED_BUYER_REFUNDED";
        // Undo the held escrow exactly as a buyer cancellation does.
        await financialService.refundHeldEscrowForOrder({ orderId: order._id, session });
        refundPayment = await Payment.findOne({ parentOrder: order._id, status: "SUCCESS" }).sort({ createdAt: -1 }).session(session);
        await Payment.updateMany({ parentOrder: order._id, status: "SUCCESS" }, { status: "REFUNDED" }, { session });
        order.paymentStatus = "REFUNDED";
        order.orderStatus = "REFUNDED";
        refundAmount = order.totalAmount;
      } else if (decision === "RELEASE_TO_VENDOR") {
        status = "RESOLVED_VENDOR_RELEASED";
        order.paymentStatus = "PAID";
        // Release the held escrow through the normal path (ledger + wallet),
        // so the money can never be released a second time on delivery.
        const held = await Settlement.find({ order: order._id, status: "HELD" }).session(session);
        for (const settlement of held) {
          await financialService.releaseEscrowToVendor({ settlementId: settlement._id, session, adminUserId: adminId });
        }
      } else if (decision === "SPLIT_SETTLEMENT") {
        refundPayment = await Payment.findOne({ parentOrder: order._id, status: "SUCCESS" }).sort({ createdAt: -1 }).session(session);
        refundAmount = buyerRefundAmount;
        status = "RESOLVED_SPLIT";
        // Refund part, release part, MVEC keeps any remainder; the held
        // settlements close so delivery can never release them again.
        await financialService.splitHeldEscrowForOrder({
          orderId: order._id, buyerRefund: buyerRefundAmount, sellerRelease: vendorReleaseAmount, session, adminUserId: adminId,
        });
        order.paymentStatus = buyerRefundAmount > 0 ? "REFUNDED" : "PAID";
        order.orderStatus = "COMPLETED"; // the case is closed and the money has moved
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

      // Refunds claw back affiliate commission: all of it for a full refund,
      // the proportional share for a partial one. Keyed on the dispute so a
      // repeated resolution can never reverse twice.
      if (decision === "REFUND_BUYER" || (decision === "SPLIT_SETTLEMENT" && buyerRefundAmount > 0)) {
        try {
          await affiliateAttribution.reverseOrderCommission({
            orderId: order._id,
            refundAmount: decision === "REFUND_BUYER" ? null : buyerRefundAmount,
            key: `dispute:${dispute._id}`,
            reason: `Dispute ${dispute.disputeNumber || dispute._id} ${decision}`,
          });
        } catch (reverseError) {
          // The dispute is already committed; surface the gap for manual follow-up.
          console.error(`Affiliate commission reversal failed for dispute ${dispute._id}:`, reverseError.message);
        }
      }

      // Send the buyer's share back to the number that paid.
      if (refundAmount > 0) {
        await require("./disbursement.service").refundPayment({
          order, payment: refundPayment, amount: refundAmount, idempotencyKey: `dispute-refund:${dispute._id}`,
        }).catch((err) => console.error(`Dispute refund ${dispute._id} failed to queue:`, err.message));
      }

      return dispute;
    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction();
      session.endSession();
      throw error;
    }
  }
}

module.exports = new DisputeService();