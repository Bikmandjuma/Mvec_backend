const express = require("express");
const router = express.Router();
const category = require("../controllers/category.controller");
const { protect, authorize } = require("../middleware/auth.middleware");
const { checkStaffPermission } = require("../middleware/staff.middleware");

// ─── PUBLIC ROUTES ──────────────────────────────────────────────────────────
router.get("/", category.getCategories);          // GET /api/categories?tree=true
router.get("/:slug", category.getCategoryBySlug);  // GET /api/categories/:slug

// ─── PROTECTED ROUTES ───────────────────────────────────────────────────────
router.use(protect);

// Sellers, suppliers and admins can add a category from any category picker;
// it then appears in every picker. Seller staff need the catalog permission.
const sellerStaffCheck = checkStaffPermission("canManageProducts");
router.post("/", authorize("vendor", "super_admin", "supplier"), (req, res, next) => (req.user.role === "supplier" ? next() : sellerStaffCheck(req, res, next)), category.createCategory);

// Only admins can modify or delete categories
router.use(authorize("super_admin"));
router.patch("/:id", category.updateCategory);     // PATCH /api/categories/:id
router.delete("/:id", category.deleteCategory);    // DELETE /api/categories/:id

module.exports = router;