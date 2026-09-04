const express = require("express");
const router = express.Router();
const supplier = require("../controllers/supplier.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// ─── PUBLIC ROUTES ──────────────────────────────────────────────────────────
router.get("/", supplier.getSuppliers);                    // GET /api/suppliers?q=&location=&page=
router.get("/:idOrSlug", supplier.getSupplierByIdOrSlug);  // GET /api/suppliers/:idOrSlug

// ─── PRIVATE: SUPPLIER'S OWN PROFILE ────────────────────────────────────────
router.post("/onboard", protect, authorize("supplier"), supplier.onboardSupplier);
router.get("/me/profile", protect, authorize("supplier"), supplier.getMyProfile);
router.patch("/me/profile", protect, authorize("supplier"), supplier.updateMyProfile);

module.exports = router;