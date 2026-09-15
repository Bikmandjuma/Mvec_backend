const express = require("express");
const router = express.Router();
const abuseReport = require("../controllers/abuseReport.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// ─── AUTHENTICATED ────────────────────────────────────────────────────────────
router.use(protect);

// Submit a new abuse report (vendor or admin)
router.post("/", authorize("vendor", "super_admin"), abuseReport.submitAbuseReport);

// List abuse reports (vendor sees own; admin sees all)
router.get("/", authorize("vendor", "super_admin"), abuseReport.listAbuseReports);

// Admin status / notes update
router.patch("/:id", authorize("super_admin"), abuseReport.updateAbuseReport);

// Single report detail (owner vendor or admin)
router.get("/:id", authorize("vendor", "super_admin"), abuseReport.getAbuseReport);

module.exports = router;