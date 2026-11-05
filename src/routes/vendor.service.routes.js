const express = require("express");
const router = express.Router();
const {
  getVendorSubscription,
  upgradeVendorSubscription,
  getMyAdvertisements,
  createAdvertisement,
  updateMyAdvertisementStatus,
  endMyAdvertisement,
} = require("../controllers/monetization.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// ─── VENDOR MONETIZATION ROUTES ─────────────────────────────────────────────
// Mounted at /api/vendor · Every route requires an authenticated vendor.

router.use(protect);
router.use(authorize("vendor"));

router.get("/subscription", getVendorSubscription);               // GET  /api/vendor/subscription
router.post("/subscription", upgradeVendorSubscription);          // POST /api/vendor/subscription
router.get("/advertisements", getMyAdvertisements);               // GET  /api/vendor/advertisements
router.post("/advertisements", require("../services/plans.service").requireFeature("promotions"), createAdvertisement);              // POST /api/vendor/advertisements
router.patch("/advertisements/:id/status", updateMyAdvertisementStatus); // PATCH /api/vendor/advertisements/:id/status
router.post("/advertisements/:id/end", endMyAdvertisement);             // POST  /api/vendor/advertisements/:id/end

module.exports = router;