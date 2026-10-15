const express = require("express");
const { protect, authorize } = require("../middleware/auth.middleware");
const ops = require("../controllers/admin.ops.controller");

const router = express.Router();
router.use(protect, authorize("super_admin"));
router.get("/attention", ops.getAttention);
router.get("/payments", ops.getPayments);
router.get("/earnings", ops.getEarnings);
router.get("/analytics", ops.getAnalytics);
router.get("/risk", ops.getRisk);
router.get("/trust", ops.getTrust);
router.get("/platform", ops.getPlatform);
router.get("/audit-logs", ops.getAuditLogs);

module.exports = router;
