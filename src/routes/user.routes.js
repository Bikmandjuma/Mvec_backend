const express = require("express");
const router = express.Router();
const user = require("../controllers/user.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

router.use(protect);

// ─── VENDOR CUSTOMERS ─────────────────────────────────────────────────────────
router.get("/vendor/customers", authorize("vendor"), user.listVendorCustomers);

// ─── USER / STORE / ORDER SEARCH (abuse report autocomplete) ──────────────────
router.get("/search", authorize("vendor", "super_admin"), user.searchUsers);

// ─── ADMIN USER MANAGEMENT ────────────────────────────────────────────────────
router.get("/", authorize("super_admin"), user.adminListUsers);
router.get("/:id", authorize("super_admin"), user.adminGetUser);
router.patch("/:id", authorize("super_admin"), user.adminUpdateUser);

module.exports = router;
