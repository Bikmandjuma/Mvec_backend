const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth.middleware");
const plans = require("../services/plans.service");
const settings = require("../services/platformSettings.service");

// GET /api/plans/me — what the signed-in seller/supplier can use, and the plan
// details shown on the Subscription pages. While the program is off every
// account has every tool.
router.get("/me", protect, async (req, res) => {
  try {
    const ops = await settings.get();
    return res.json({
      entitlements: await plans.entitlements(req.user.id),
      programActive: Boolean(ops.subscriptionsEnabled),
      sellerPremiumPrice: ops.sellerPremiumPrice,
      freeProductLimit: ops.freeProductLimit,
      premiumFeatures: plans.FEATURES,
      freeIncludes: plans.FREE_INCLUDES,
    });
  } catch (error) {
    return res.status(500).json({ message: "Could not load your plan." });
  }
});

module.exports = router;
