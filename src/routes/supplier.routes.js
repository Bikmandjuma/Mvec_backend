const express = require("express");
const router = express.Router();
const supplier = require("../controllers/supplier.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// ─── PUBLIC ROUTES ──────────────────────────────────────────────────────────
router.get("/", supplier.getSuppliers);                    // GET /api/suppliers?q=&location=&page=

// ─── PRIVATE: SUPPLIER'S OWN WHOLESALE CATALOG ──────────────────────────────
// NOTE: /me/* must be registered ahead of /:idOrSlug and /:id/products so that
// "me" is interpreted as a self-reference instead of a supplier id.
router.get("/me/products", protect, authorize("supplier"), supplier.getMyWholesaleProducts);
router.post("/me/products", protect, authorize("supplier"), supplier.createWholesaleProduct);
router.put("/me/products/:productId", protect, authorize("supplier"), supplier.updateWholesaleProduct);
router.delete("/me/products/:productId", protect, authorize("supplier"), supplier.deleteWholesaleProduct);

router.get("/:idOrSlug", supplier.getSupplierByIdOrSlug);  // GET /api/suppliers/:idOrSlug
router.get("/:id/products", supplier.getSupplierProducts); // GET /api/suppliers/:id/products

// ─── PRIVATE: SUPPLIER'S OWN PROFILE ────────────────────────────────────────
router.post("/onboard", protect, authorize("supplier"), supplier.onboardSupplier);
router.get("/me/profile", protect, authorize("supplier"), supplier.getMyProfile);
router.patch("/me/profile", protect, authorize("supplier"), supplier.updateMyProfile);

module.exports = router;