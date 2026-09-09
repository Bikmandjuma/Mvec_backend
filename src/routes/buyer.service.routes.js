const express = require("express");
const router = express.Router();
const {
  getBuyerSubscription,
  upgradeBuyerSubscription,
} = require("../controllers/monetization.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// ─── BUYER MONETIZATION ROUTES ──────────────────────────────────────────────
// Mounted at /api/buyer · Every route requires an authenticated buyer.

router.use(protect);
router.use(authorize("buyer"));

router.get("/subscription", getBuyerSubscription);       // GET  /api/buyer/subscription
router.post("/subscription", upgradeBuyerSubscription);  // POST /api/buyer/subscription

module.exports = router;
