const express = require("express");
const router = express.Router();
const report = require("../controllers/report.controller");
const { protect } = require("../middleware/auth.middleware");

router.use(protect);

router.get("/summary", report.getSummary);
router.get("/revenue", report.getRevenueSeries);

module.exports = router;
