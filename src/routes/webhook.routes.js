const express = require("express");
const router = express.Router();
const { handleMomoWebhook, handleAirtelWebhook } = require("../controllers/webhook.controller");

// MTN MoMo payment callback (public, provider-verified)
router.post("/momo", handleMomoWebhook);

// Airtel Money payment callback (public, provider-verified)
router.post("/airtel", handleAirtelWebhook);

module.exports = router;
