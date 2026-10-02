const express = require("express");
const router = express.Router();
const { handleMomoWebhook, handleAirtelWebhook, handlePaypackWebhook } = require("../controllers/webhook.controller");
const verifyAirtelSignature = require("../middleware/verifyAirtelSignature");

// MTN MoMo payment callback (public, provider-verified)
router.post("/momo", handleMomoWebhook);

// Airtel Money payment callback (public, provider-verified via HMAC signature)
router.post("/airtel", verifyAirtelSignature, handleAirtelWebhook);

// Paypack payment callback (public, provider-verified via X-Paypack-Signature)
router.head("/paypack", (req, res) => res.sendStatus(200));
router.post("/paypack", handlePaypackWebhook);

module.exports = router;