const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth.middleware");
const { initiateMoMoPayment, initiateAirtelPayment, handlePaymentWebhook, confirmPayment } = require("../controllers/payment.controller");

// Initiate MTN MoMo Push Notification
router.post("/pay/momo", protect, initiateMoMoPayment);

// Initiate Airtel Money Push Notification
router.post("/pay/airtel", protect, initiateAirtelPayment);

// Direct Confirmation (Card, Bank, or dev confirmation)
router.post("/confirm", protect, confirmPayment);

// Gateway Webhook Callback (Public endpoint verified via idempotency & reference check)
router.post("/webhook", handlePaymentWebhook);

module.exports = router;