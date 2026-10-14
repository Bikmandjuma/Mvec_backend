const express = require("express");
const router = express.Router();
const report = require("../controllers/report.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// Sellers see their own figures; admins see the whole marketplace. Nobody else.
router.use(protect, authorize("vendor", "super_admin"));

router.get("/summary", report.getSummary);
router.get("/revenue", report.getRevenueSeries);

module.exports = router;
