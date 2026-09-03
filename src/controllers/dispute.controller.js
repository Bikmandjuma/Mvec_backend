const disputeService = require("../services/dispute.service");
const socketService = require("../services/socket.service");

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