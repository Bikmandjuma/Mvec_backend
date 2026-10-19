// Verifies Airtel Money callbacks (HMAC-SHA256 of the raw body, hex) with
// AIRTEL_WEBHOOK_SECRET before the controller touches any order.
const { checkWebhook, hmacMatches } = require("../utils/webhookAuth");

module.exports = (req, res, next) => {
  const signature = req.headers["x-airtel-signature"] || req.headers["x-signature"];
  const failure = checkWebhook({
    provider: "Airtel",
    secret: process.env.AIRTEL_WEBHOOK_SECRET,
    signature,
    verify: (sig, secret) => hmacMatches(req, sig, secret),
  });
  if (failure) return res.status(failure.status).json({ message: failure.message });
  return next();
};
