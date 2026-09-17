const disputeService = require("../services/dispute.service");
const Dispute = require("../models/Dispute");
const socketService = require("../services/socket.service");

const DISPUTE_POPULATE = [
  { path: "order", select: "orderNumber totalAmount status createdAt" },
  { path: "raisedBy", select: "Fullname email" },
  { path: "vendor", select: "Fullname email companyName" },
  { path: "arbitrationDecision.arbitratedBy", select: "Fullname email" },
];

exports.adminListDisputes = async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const query = {};
    if (status) query.status = status;
    const disputes = await Dispute.find(query)
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .populate(DISPUTE_POPULATE);
    const total = await Dispute.countDocuments(query);
    return res.status(200).json({ success: true, data: disputes, meta: { total } });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.listMyDisputes = async (req, res) => {
  try {
    const userId = req.user.id;
    const disputes = await Dispute.find({
      $or: [{ raisedBy: userId }, { vendor: userId }],
    })
      .sort({ createdAt: -1 })
      .populate(DISPUTE_POPULATE);
    return res.status(200).json({ success: true, data: disputes });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.openDispute = async (req, res) => {
  try {
    const { orderId, reason, description, disputedAmount } = req.body;
    const raisedById = req.user.id;

    const dispute = await disputeService.openDispute({
      orderId,
      raisedById,
      reason,
      description,
      disputedAmount,
    });

    return res.status(201).json({
      success: true,
      message: "Dispute case opened successfully.",
      data: dispute,
    });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

exports.submitEvidence = async (req, res) => {
  try {
    const { disputeId } = req.params;
    const { message, attachments } = req.body;

    const evidence = await disputeService.submitEvidence({
      disputeId,
      userId: req.user.id,
      userRole: req.user.role,
      message,
      attachments,
    });

    // Broadcast Realtime Message to Dispute Room
    socketService.emitToRoom(`dispute:${disputeId}`, "new_evidence_submitted", evidence);

    return res.status(201).json({
      success: true,
      message: "Evidence attached to dispute successfully.",
      data: evidence,
    });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};

exports.resolveArbitration = async (req, res) => {
  try {
    const { disputeId } = req.params;
    const { decision, buyerRefundAmount, vendorReleaseAmount, notes } = req.body;
    const adminId = req.user.id;

    const dispute = await disputeService.resolveDisputeArbitration({
      disputeId,
      adminId,
      decision,
      buyerRefundAmount,
      vendorReleaseAmount,
      notes,
    });

    // Broadcast Decision Realtime
    socketService.emitToRoom(`dispute:${disputeId}`, "dispute_resolved", dispute);

    return res.status(200).json({
      success: true,
      message: "Arbitration decision executed successfully.",
      data: dispute,
    });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
};