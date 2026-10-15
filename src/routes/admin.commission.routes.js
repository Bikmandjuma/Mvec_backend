const express = require("express");
const router = express.Router();
const c = require("../controllers/commission.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

router.use("/commissions", protect, authorize("super_admin"));
router.use("/commission-settings", protect, authorize("super_admin"));

router.get("/commissions", c.getCommissionRules);
router.get("/commissions/preview", c.previewSplit);
router.post("/commissions", c.createCommissionRule);
router.put("/commissions/:id", c.updateCommissionRule);
router.patch("/commissions/:id/toggle", c.toggleCommissionRule);
router.delete("/commissions/:id", c.deleteCommissionRule);
router.get("/commission-settings", c.getSettings);
router.put("/commission-settings", c.updateSettings);

module.exports = router;
