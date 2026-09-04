const express = require("express");
const router = express.Router();
const vendor = require("../controllers/vendor.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

router.use(protect, authorize("super_admin"));

router.get("/", vendor.adminGetVendors);                    // GET /api/admin/vendors
router.patch("/:id/verify", vendor.adminVerifyVendor);      // PATCH /api/admin/vendors/:id/verify
router.patch("/:id/status", vendor.adminUpdateVendorStatus); // PATCH /api/admin/vendors/:id/status

module.exports = router;