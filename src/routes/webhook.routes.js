const express = require("express");
const router = express.Router();
const { handleMomoWebhook, handleAirtelWebhook } = require("../controllers/webhook.controller");
const verifyAirtelSignature = require("../middleware/verifyAirtelSignature");
const {protect, authorize} = require("../middleware/auth.middleware");

// MTN MoMo payment callback (public, provider-verified)
router.post("/momo",protect, handleMomoWebhook);

// Airtel Money payment callback (public, provider-verified)
router.post("/airtel",protect, verifyAirtelSignature, handleAirtelWebhook);

module.exports = router;
