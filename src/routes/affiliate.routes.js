const express = require("express");
const router = express.Router();
const affiliateController = require("../controllers/affiliate.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// Affiliate dashboard (wallet, links, aggregates, own payouts)
router.get("/me/dashboard", protect, affiliateController.getMyDashboard);

// Own payout history
router.get("/payouts", protect, affiliateController.listMyPayouts);

// Own conversion/order audit trail
router.get("/conversions", protect, affiliateController.getMyConversions);

// Super Admin: list all affiliate accounts with aggregated stats
router.get("/", protect, authorize("super_admin"), affiliateController.adminListAffiliates);

// Super Admin: review all affiliate payout requests
router.get("/admin/payouts", protect, authorize("super_admin"), affiliateController.adminListPayouts);

// Generate referral link
router.post("/links", protect, affiliateController.generateLink);

// Public click tracking endpoint
router.get("/track/:code", affiliateController.trackClick);

// Request Affiliate Balance Payout (10,000 RWF Enforced)
router.post("/payouts/request", protect, affiliateController.requestPayout);

// Super Admin Payout Review and Settlement Execution
router.post(
  "/payouts/:payoutId/process",
  protect,
  authorize("super_admin"),
  affiliateController.adminProcessPayout
);

module.exports = router;