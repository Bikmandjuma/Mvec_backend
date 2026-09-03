const express = require("express");
const router = express.Router();
const disputeController = require("../controllers/dispute.controller");
const { protect, authorize } = require("../middleware/auth.middleware"); // Adjust middleware import path if needed

// Open a dispute case for an order
router.post("/", protect, disputeController.openDispute);

// Attach chat evidence/documents to dispute case
router.post("/:disputeId/evidence", protect, disputeController.submitEvidence);

// Admin binding arbitration execution
router.post(
  "/:disputeId/arbitrate",
  protect,
  authorize("super_admin"),
  disputeController.resolveArbitration
);

module.exports = router;