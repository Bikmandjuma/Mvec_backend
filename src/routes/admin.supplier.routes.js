// routes/admin.supplier.routes.js
const express = require("express");
const router = express.Router();
const supplier = require("../controllers/supplier.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

router.use(protect, authorize("super_admin"));

router.get("/", supplier.adminGetSuppliers);                    // GET /api/admin/suppliers
router.patch("/:id/verify", supplier.adminVerifySupplier);      // PATCH /api/admin/suppliers/:id/verify
router.patch("/:id/status", supplier.adminUpdateSupplierStatus); // PATCH /api/admin/suppliers/:id/status

module.exports = router;