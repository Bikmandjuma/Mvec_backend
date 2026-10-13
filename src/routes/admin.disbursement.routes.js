const express = require("express");
const router = express.Router();
const Disbursement = require("../models/Disbursement");
const disbursementService = require("../services/disbursement.service");
const { protect, authorize } = require("../middleware/auth.middleware");

// Mounted at /api/admin/disbursements · refunds and affiliate withdrawals
// MVEC has sent (or is sending) to mobile money.
router.use(protect, authorize("super_admin"));

// GET /api/admin/disbursements?status=FAILED&kind=REFUND
router.get("/", async (req, res) => {
  const filter = {};
  if (["QUEUED", "SENT", "SUCCESS", "FAILED"].includes(req.query.status)) filter.status = req.query.status;
  if (["REFUND", "AFFILIATE_PAYOUT"].includes(req.query.kind)) filter.kind = req.query.kind;
  const rows = await Disbursement.find(filter)
    .sort({ createdAt: -1 })
    .limit(200)
    .populate("recipient", "Fullname phone")
    .populate("order", "orderNumber");
  res.json({ data: rows });
});

// POST /api/admin/disbursements/:id/retry
router.post("/:id/retry", async (req, res) => {
  try {
    const d = await disbursementService.retryNow(req.params.id);
    res.json({ message: d.status === "SUCCESS" ? "Transfer sent." : `Transfer ${d.status.toLowerCase()}.`, data: d });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Could not retry the transfer." });
  }
});

module.exports = router;
