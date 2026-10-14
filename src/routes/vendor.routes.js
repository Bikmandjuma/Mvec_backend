const express = require("express");
const router = express.Router();
const vendor = require("../controllers/vendor.controller");
const { protect, authorize } = require("../middleware/auth.middleware");
const { checkStaffPermission } = require("../middleware/staff.middleware");

// ─── PUBLIC ROUTES ──────────────────────────────────────────────────────────
router.get("/", vendor.getVendors);                    // GET /api/vendors?q=&location=&page=
router.get("/:idOrSlug", vendor.getVendorByIdOrSlug);  // GET /api/vendors/:idOrSlug

// ─── PRIVATE: VENDOR'S OWN PROFILE ──────────────────────────────────────────
router.post("/become-seller", protect, authorize("super_admin"), vendor.becomeSeller);
router.post("/onboard", protect, authorize("vendor"), vendor.onboardVendor);
router.get("/me/profile", protect, authorize("vendor"), vendor.getMyProfile);
router.patch("/me/profile", protect, authorize("vendor"), vendor.updateMyProfile);

// ─── PRIVATE: SELLER'S AFFILIATE PROGRAM ────────────────────────────────────
router.get("/me/affiliate-program", protect, authorize("vendor"), checkStaffPermission("canManageProducts"), vendor.getAffiliateProgram);
router.put("/me/affiliate-program", protect, authorize("vendor"), checkStaffPermission("canManageSettings"), vendor.updateAffiliateProgram);

module.exports = router;
