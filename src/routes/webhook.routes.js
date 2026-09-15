const express = require("express");
const router = express.Router();
const { handleMomoWebhook, handleAirtelWebhook } = require("../controllers/webhook.controller");
const verifyAirtelSignature = require("../middleware/verifyAirtelSignature");

// MTN MoMo payment callback (public, provider-verified)
router.post("/momo", handleMomoWebhook);

// Airtel Money payment callback (public, provider-verified via HMAC signature)
router.post("/airtel", verifyAirtelSignature, handleAirtelWebhook);

module.exports = router;