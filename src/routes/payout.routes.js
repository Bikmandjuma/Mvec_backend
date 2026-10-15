const express = require("express");
const router = express.Router();
const {
  getVendorBalance,
  requestPayout,
  getPayoutHistory,
  cancelPayout,
  getStatement,
} = require("../controllers/payout.controller");

const { protect, authorize } = require("../middleware/auth.middleware");

// Require authentication for all payout endpoints
router.use(protect);

// Vendor financial endpoints. Requests are paid out by MVEC finance (admin).
router.get("/balance", authorize("vendor"), getVendorBalance);
router.post("/request", authorize("vendor"), requestPayout);
router.get("/history", authorize("vendor"), getPayoutHistory);
router.get("/statement", authorize("vendor"), getStatement);
router.post("/:id/cancel", authorize("vendor"), cancelPayout);

module.exports = router;