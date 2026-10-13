const express = require("express");
const router = express.Router();
const {
  getBuyerSubscription,
  upgradeBuyerSubscription,
  buyerPremiumCheckout,
} = require("../controllers/monetization.controller");
const { protect, authorize } = require("../middleware/auth.middleware");
const limits = require("../middleware/rateLimits");

// ─── BUYER MONETIZATION ROUTES ──────────────────────────────────────────────
// Mounted at /api/buyer · Every route requires an authenticated buyer.

router.use(protect);
router.use(authorize("buyer"));

router.get("/subscription", getBuyerSubscription);       // GET  /api/buyer/subscription
router.post("/subscription", upgradeBuyerSubscription);  // POST /api/buyer/subscription (cancel back to Free)
router.post("/subscription/checkout", limits.payment, buyerPremiumCheckout); // pay for Premium

module.exports = router;
