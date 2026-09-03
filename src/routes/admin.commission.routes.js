const express = require("express");
const router = express.Router();
const { createCommissionRule, getCommissionRules, toggleCommissionRule } = require("../controllers/commission.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

router.use(protect, authorize("super_admin"));

router.post("/commissions", createCommissionRule);
router.get("/commissions", getCommissionRules);
router.patch("/commissions/:id/toggle", toggleCommissionRule);

module.exports = router;