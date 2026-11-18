const express = require("express");
const rider = require("../controllers/rider.controller");
const limits = require("../middleware/rateLimits");
const { protect, authorize } = require("../middleware/auth.middleware");

const router = express.Router();

router.post("/register", limits.register, rider.register);

router.use(protect, authorize("delivery"));
router.get("/me", rider.me);
router.patch("/location", rider.location);
router.patch("/availability", rider.availability);
router.get("/stats", rider.stats);
router.get("/deliveries/available", rider.available);
router.get("/deliveries/active", rider.active);
router.get("/deliveries/history", rider.history);
router.post("/deliveries/:id/accept", rider.accept);
router.post("/deliveries/:id/reject", rider.reject);
router.patch("/deliveries/:id/status", rider.status);
router.post("/deliveries/:id/confirm", limits.verifyCode, rider.confirm);
router.get("/deliveries/:id/navigation", rider.navigation);

// Earnings wallet: withdrawals and their history work as for sellers.
const payouts = require("../controllers/payout.controller");
router.get("/wallet", rider.wallet);
router.post("/wallet/withdrawals", payouts.requestPayout);
router.get("/wallet/withdrawals", payouts.getPayoutHistory);

module.exports = router;
