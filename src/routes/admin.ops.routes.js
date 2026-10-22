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

// Operational settings: automatic release days, subscription program & prices.
const settings = require("../services/platformSettings.service");
router.get("/operations-settings", async (req, res) => {
  try { return res.json({ settings: await settings.get(), limits: settings.LIMITS }); }
  catch (error) { return res.status(500).json({ message: "Could not load the settings." }); }
});
router.put("/operations-settings", async (req, res) => {
  try {
    const next = await settings.update(req.body || {}, req.user._id || req.user.id);
    return res.json({ message: "Settings saved.", settings: next });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Could not save the settings." });
  }
});

module.exports = router;
