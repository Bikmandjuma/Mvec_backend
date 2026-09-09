const express = require("express");
const router = express.Router();
const {
  adminListSubscriptions,
  adminUpdateSubscriptionStatus,
  adminListAdvertisements,
  adminUpdateAdvertisementStatus,
  adminListBuyerSubscriptions,
} = require("../controllers/monetization.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// ─── ADMIN MONETIZATION ROUTES ──────────────────────────────────────────────
// Mounted at /api/admin · Every route requires an authenticated super_admin.

router.use(protect);
router.use(authorize("super_admin"));

router.get("/subscriptions", adminListSubscriptions);                 // GET  /api/admin/subscriptions
router.patch("/subscriptions/:id/status", adminUpdateSubscriptionStatus); // PATCH /api/admin/subscriptions/:id/status
router.get("/advertisements", adminListAdvertisements);               // GET  /api/admin/advertisements
router.patch("/advertisements/:id/status", adminUpdateAdvertisementStatus); // PATCH /api/admin/advertisements/:id/status
router.get("/buyer-subscriptions", adminListBuyerSubscriptions);      // GET  /api/admin/buyer-subscriptions

module.exports = router;