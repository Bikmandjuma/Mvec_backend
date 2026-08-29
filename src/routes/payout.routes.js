const express = require("express");
const router = express.Router();
const {
  getVendorBalance,
  requestPayout,
  getPayoutHistory,
  processPayout,
} = require("../controllers/payout.controller");

const { protect, authorize } = require("../middleware/auth.middleware");

router.use(protect);

// Vendor Financial Endpoints
router.get("/balance", authorize("vendor"), getVendorBalance);
router.post("/request", authorize("vendor"), requestPayout);
router.get("/history", authorize("vendor"), getPayoutHistory);

// Super Admin Management
router.patch("/admin/:id/process", authorize("super_admin"), processPayout);

module.exports = router;