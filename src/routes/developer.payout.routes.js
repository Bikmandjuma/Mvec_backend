const express = require("express");
const router = express.Router();
const {
  getDeveloperBalance,
  requestDeveloperPayout,
  getDeveloperPayoutHistory,
} = require("../controllers/developer.payout.controller");

const { protect, authorize } = require("../middleware/auth.middleware");

router.use(protect);
router.use(authorize("developer"));

router.get("/balance", getDeveloperBalance);
router.post("/request", requestDeveloperPayout);
router.get("/history", getDeveloperPayoutHistory);

module.exports = router;
