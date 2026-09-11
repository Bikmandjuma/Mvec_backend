const express = require("express");
const router = express.Router();
const {
  getAdminBalance,
  requestAdminPayout,
  getAdminPayoutHistory,
} = require("../controllers/admin.payout.controller");

const { protect, authorize } = require("../middleware/auth.middleware");

router.use(protect);
router.use(authorize("super_admin", "admin"));

router.get("/balance", getAdminBalance);
router.post("/request", requestAdminPayout);
router.get("/history", getAdminPayoutHistory);

module.exports = router;
