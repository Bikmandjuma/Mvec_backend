// src/services/paypack.service.js
// Paypack (https://paypack.rw) payment gateway abstraction.
//
// Paypack collects from both MTN MoMo and Airtel Money numbers through a single
// "cashin" API, so it replaces the per-provider MoMo / Airtel integrations.
// It exposes the same interface (isSandbox, triggerUssdPush, getTransactionStatus)
// consumed by the polymorphic helper in payment.controller.js.
//
// Required env: PAYPACK_CLIENT_ID, PAYPACK_CLIENT_SECRET
// Optional env: PAYPACK_BASE_URL, PAYPACK_WEBHOOK_SECRET, PAYPACK_WEBHOOK_MODE

const crypto = require("crypto");
const axios = require("axios");
const NodeCache = require("node-cache");

const tokenCache = new NodeCache();

const BASE_URL = () => process.env.PAYPACK_BASE_URL || "https://payments.paypack.rw/api";

// Paypack sends webhooks only to the URL registered for the matching mode.
const WEBHOOK_MODE = () =>
  process.env.PAYPACK_WEBHOOK_MODE || (process.env.NODE_ENV === "production" ? "production" : "development");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Without credentials there is nothing to call, so payments are simulated.
function isSandbox() {
  return !process.env.PAYPACK_CLIENT_ID || !process.env.PAYPACK_CLIENT_SECRET;
}

/**
 * Map a Paypack transaction status ("pending" | "successful" | "failed")
 * onto the status vocabulary used by the rest of the payment flow.
 */
function normalizeStatus(status) {
  const value = String(status || "").toLowerCase();
  if (value === "successful" || value === "success") return "SUCCESSFUL";
  if (value === "failed") return "FAILED";
  return "PENDING";
}

// ---------------------------------------------------------------------------
// OAuth Token
// ---------------------------------------------------------------------------

/**
 * Obtain an access token from Paypack, cached until shortly before it expires.
 *
 * POST ${PAYPACK_BASE_URL}/auth/agents/authorize  { client_id, client_secret }
 * -> { access, refresh, expires }  (expires is a unix timestamp in seconds)
 */
async function getAccessToken() {
  const cachedToken = tokenCache.get("paypack_access_token");
  if (cachedToken) return cachedToken;

  const response = await axios.post(`${BASE_URL()}/auth/agents/authorize`, {
    client_id: process.env.PAYPACK_CLIENT_ID,
    client_secret: process.env.PAYPACK_CLIENT_SECRET,
  });

  const { access, expires } = response.data || {};
  if (!access) throw new Error("Failed to retrieve access token from Paypack.");

  const ttl = Math.max(Number(expires) - Math.floor(Date.now() / 1000) - 60, 60);
  tokenCache.set("paypack_access_token", access, ttl || 600);
  return access;
}

async function authHeaders() {
  const token = await getAccessToken();
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Webhook-Mode": WEBHOOK_MODE(),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Trigger a USSD push (Paypack "cashin") to the buyer's phone number.
 *
 * POST ${PAYPACK_BASE_URL}/transactions/cashin  { amount, number }
 * -> { amount, created_at, kind: "CASHIN", ref, status: "pending" }
 *
 * The returned `ref` is Paypack's transaction id; it is echoed back in the
 * webhook (data.ref) and used to poll the transaction status.
 */
async function triggerUssdPush({ amount, phone }) {
  if (isSandbox()) {
    return {
      success: true,
      reference: `SANDBOX-${crypto.randomUUID()}`,
      status: "PENDING",
      raw: { sandbox: true, message: "Paypack cashin simulated (no credentials configured)" },
    };
  }

  // Paypack expects the local format, e.g. 0788123456.
  const number = String(phone).replace(/^250/, "0");

  try {
    const response = await axios.post(
      `${BASE_URL()}/transactions/cashin`,
      { amount: Number(amount), number },
      { headers: await authHeaders() },
    );

    return {
      success: true,
      reference: response.data.ref,
      status: normalizeStatus(response.data.status),
      raw: response.data,
    };
  } catch (error) {
    const detail = error.response ? JSON.stringify(error.response.data) : error.message;
    throw new Error(`Paypack cashin failed${error.response ? ` (${error.response.status})` : ""}: ${detail}`);
  }
}

/**
 * Look up the final status of a transaction by its Paypack ref.
 *
 * GET ${PAYPACK_BASE_URL}/events/transactions?ref=<ref>
 * The most recent event carries the current status.
 */
async function getTransactionStatus(ref) {
  if (isSandbox()) {
    return { status: "SUCCESSFUL", reference: ref };
  }

  const response = await axios.get(`${BASE_URL()}/events/transactions`, {
    params: { ref },
    headers: await authHeaders(),
  });

  const events = response.data?.transactions || [];
  const latest = events
    .map((event) => event.data || event)
    .sort((a, b) => new Date(b.processed_at || b.created_at) - new Date(a.processed_at || a.created_at))[0];

  if (!latest) return { status: "PENDING", reference: ref, raw: response.data };

  return {
    status: normalizeStatus(latest.status),
    reference: ref,
    amount: Number(latest.amount),
    fee: Number(latest.fee) || 0,
    raw: latest,
  };
}

/**
 * Verify the X-Paypack-Signature header: base64 HMAC-SHA256 of the raw
 * request body, keyed with the webhook secret from the Paypack dashboard.
 */
function verifyWebhookSignature(rawBody, signatureHeader, secret = process.env.PAYPACK_WEBHOOK_SECRET) {
  if (!rawBody || !signatureHeader || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signatureHeader));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  isSandbox,
  normalizeStatus,
  getAccessToken,
  triggerUssdPush,
  getTransactionStatus,
  verifyWebhookSignature,
};
