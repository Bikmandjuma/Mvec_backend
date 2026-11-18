// Development or live, decided in one place. Requiring this loads .env first,
// so every module that reads process.env sees it.
require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env"), quiet: true });

// The server is a development server only when NODE_ENV says so
// (`development` or `test`). Anything else, including a missing NODE_ENV,
// counts as live, so a server deployed without NODE_ENV gets the strict
// behaviour (signed webhooks, real gateways, no console SMS), not the relaxed one.
const isTest = () => process.env.NODE_ENV === "test";
const isLive = () => !["development", "test"].includes(process.env.NODE_ENV);

const EXAMPLE_SECRET = /your_|change_me|secret_key_here|example/i;
const isLocalUrl = (url) => /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:|\/|$)/i.test(url || "");

/** Tokens signed with a short or example secret can be forged by anyone who has read .env.example. */
const weakJwtSecret = (secret) => !secret || secret.length < 32 || EXAMPLE_SECRET.test(secret);

/**
 * Settings checked once at startup, all at once, so a live server either starts
 * correctly configured or refuses with the full list of what to fix.
 *  - errors: unsafe on a live server; it refuses to start (development only warns).
 *  - warnings: optional features that are off; the server starts anyway.
 */
function startupReport(env = process.env) {
  const errors = [];
  const warnings = [];

  if (weakJwtSecret(env.JWT_SECRET)) {
    errors.push("JWT_SECRET is missing, shorter than 32 characters or the example value: set a random one");
  }
  if (!env.DB_PASSWORD && !env.MYSQL_PASSWORD) {
    errors.push("DB_PASSWORD is empty: give the database user a password and keep the database off the internet");
  }
  if (!env.FRONTEND_URL || isLocalUrl(env.FRONTEND_URL)) {
    errors.push("FRONTEND_URL is not the website's public address: email links and CORS would point to localhost");
  }
  for (const key of ["MOMO_WEBHOOK_SECRET", "AIRTEL_WEBHOOK_SECRET", "PAYPACK_WEBHOOK_SECRET"]) {
    if (env[key] && EXAMPLE_SECRET.test(env[key])) errors.push(`${key} is still the example value: copy the real secret from the provider`);
  }
  if (env.ADMIN_PASSWORD && (EXAMPLE_SECRET.test(env.ADMIN_PASSWORD) || env.ADMIN_PASSWORD.length < 12)) {
    errors.push("ADMIN_PASSWORD is the example value or shorter than 12 characters");
  }
  const sms = (env.SMS_PROVIDER || "").trim().toLowerCase();
  const smsReady = (sms === "pindo" && env.PINDO_API_TOKEN) || (sms === "africastalking" && env.AT_USERNAME && env.AT_API_KEY);
  if (!smsReady) {
    const message = "No SMS gateway (SMS_PROVIDER=pindo with PINDO_API_TOKEN, or africastalking with AT_USERNAME and AT_API_KEY): sign-in codes could not be delivered";
    // Until SMS is set up, riders see their codes on screen, so a live server can run.
    if (showRiderCodes(env)) {
      warnings.push(message);
      warnings.push("Riders see their sign-in codes on screen because no text can be sent. Anyone with a rider's phone number can sign in as them. Set SHOW_RIDER_CODES=false once SMS works");
    } else errors.push(message);
  }

  if (env.ALLOW_UNSIGNED_WEBHOOKS === "true") {
    warnings.push("ALLOW_UNSIGNED_WEBHOOKS is set but ignored on a live server: remove it");
  }
  const gateways = [
    env.MOMO_BASE_URL,
    env.AIRTEL_GATEWAY_BASE_URL,
    env.PAYPACK_CLIENT_ID && env.PAYPACK_CLIENT_SECRET,
    env.FLW_SECRET_KEY,
    env.KPAY_API_KEY,
  ];
  if (!gateways.some(Boolean)) {
    warnings.push("No payment gateway is configured: online payments are refused until one is connected");
  }
  if (!(env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY)) {
    warnings.push("No push notifications (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY): riders and buyers only see alerts while the app is open");
  }
  if (!(env.EMAIL_USER && env.EMAIL_PASS)) {
    warnings.push("No email account (EMAIL_USER, EMAIL_PASS): verification and receipt emails are not sent");
  }

  return { errors, warnings };
}

/**
 * Temporary, until SMS works: riders (sign-up and sign-in only) see their code
 * on screen when no text can be sent. On by default, live servers included;
 * SHOW_RIDER_CODES=false turns it off.
 */
function showRiderCodes(env = process.env) {
  return String(env.SHOW_RIDER_CODES ?? "").trim().toLowerCase() !== "false";
}

module.exports = { isLive, isTest, weakJwtSecret, startupReport, showRiderCodes };
