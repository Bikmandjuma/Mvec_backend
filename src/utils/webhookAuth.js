const crypto = require("crypto");

// Payment callbacks mark orders as paid, so they are only trusted when signed.
// Unsigned callbacks are accepted only outside production, and only when
// ALLOW_UNSIGNED_WEBHOOKS=true is set on purpose (local sandbox testing).
const unsignedAllowed = () =>
  process.env.NODE_ENV !== "production" && process.env.ALLOW_UNSIGNED_WEBHOOKS === "true";

// HMAC-SHA256 (hex) over the exact bytes the provider sent.
function hmacMatches(req, signature, secret) {
  if (!signature || !secret) return false;
  const body = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(body).digest("hex"));
  const given = Buffer.from(String(signature));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

// Returns null when the callback may be processed, otherwise { status, message }.
// `verify` checks the signature with the configured secret.
function checkWebhook({ secret, signature, verify, provider }) {
  if (!secret) {
    if (unsignedAllowed()) return null;
    console.error(`[${provider} Webhook] No webhook secret configured; rejecting callback.`);
    return { status: 503, message: "Webhook verification is not configured." };
  }
  if (!signature && unsignedAllowed()) return null;
  if (!verify(signature, secret)) return { status: 401, message: "Invalid webhook signature" };
  return null;
}

module.exports = { checkWebhook, hmacMatches, unsignedAllowed };
