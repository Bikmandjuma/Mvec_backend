// src/routes/payment.routes.js
const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth.middleware");
const { initiateMoMoPayment, handlePaymentWebhook } = require("../controllers/payment.controller");

// Initiate MoMo Push Notification Prompt
router.post("/momo/initiate", protect, initiateMoMoPayment);

// Payment Gateway Webhook Callback (No protect middleware - called directly by Paystack)
router.post("/webhook", handlePaymentWebhook);

module.exports = router;