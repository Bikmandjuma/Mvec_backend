const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth.middleware");
const { initiateMoMoPayment, handlePaymentWebhook, confirmPayment } = require("../controllers/payment.controller");

// Initiate MoMo / Airtel Push Notification
router.post("/momo/initiate", protect, initiateMoMoPayment);

// Direct Confirmation (Card, Bank, or dev confirmation)
router.post("/confirm", protect, confirmPayment);

// Gateway Webhook Callback (Public endpoint verified via idempotency & reference check)
router.post("/webhook", handlePaymentWebhook);

module.exports = router;