// src/services/momo.service.js
// MTN Mobile Money (MoMo) payment gateway abstraction.
//
// Mirrors airtel.service.js so the collection (USSD push) flow works end-to-end
// in both sandbox/dev (no real credentials required) and production.
//
// To connect to the live MTN MoMo OpenAPI set:
//   MOMO_BASE_URL, MOMO_API_USER, MOMO_API_KEY, MOMO_PRIMARY_KEY, MOMO_TARGET_ENV

const crypto = require("crypto");
const axios = require("axios");
const NodeCache = require("node-cache");

const tokenCache = new NodeCache({ stdTTL: 3300 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSandbox() {
  return process.env.NODE_ENV !== "production" || !process.env.MOMO_BASE_URL;
}

function generateExternalId() {
  return `MVEC${Date.now()}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// OAuth Token
// ---------------------------------------------------------------------------

/**
 * Obtain an OAuth token from the MTN MoMo Collection API.
 *
 * Authenticates with Basic Auth (MOMO_API_USER:MOMO_API_KEY) and passes the
 * Ocp-Apim-Subscription-Key header (MOMO_PRIMARY_KEY).
 *
 * Tokens are cached for ~55 minutes (TTL 3300 s) so subsequent calls skip
 * the network round-trip.
 */
const getMomoAccessToken = async () => {
  const cachedToken = tokenCache.get("momo_access_token");
  if (cachedToken) return cachedToken;

  const credentials = Buffer.from(
    `${process.env.MOMO_API_USER}:${process.env.MOMO_API_KEY}`,
  ).toString("base64");

  const response = await axios.post(
    `${process.env.MOMO_BASE_URL}/collection/token/`,
    {},
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        "Ocp-Apim-Subscription-Key": process.env.MOMO_PRIMARY_KEY,
      },
    },
  );

  const token = response.data.access_token;
  if (!token) throw new Error("Failed to retrieve access token from MTN MoMo.");

  tokenCache.set("momo_access_token", token);
  return token;
};

// ---------------------------------------------------------------------------
// Public API – Request to Pay
// ---------------------------------------------------------------------------

/**
 * Initiate an MoMo payment (request to pay).
 *
 * POST ${MOMO_BASE_URL}/collection/v1_0/requesttopay
 *
 * @param {Object}  opts
 * @param {string}  opts.phoneNumber  - MSISDN in international format (e.g. 250788123456)
 * @param {number}  opts.amount       - Payment amount in RWF
 * @param {string}  [opts.reference]  - Optional external reference; a UUID v4 is generated when omitted
 * @returns {Promise<{reference: string, status: string, raw: object}>}
 */
const initiateMomoPayment = async ({ phoneNumber, amount, reference }) => {
  const token = await getMomoAccessToken();
  const xReferenceId = reference || crypto.randomUUID();

  const payload = {
    amount: String(amount),
    currency: "RWF",
    externalId: xReferenceId,
    payer: {
      partyIdType: "MSISDN",
      partyId: phoneNumber,
    },
    payerMessage: `MVEC payment of RWF ${amount}`,
    payeeNote: "MVEC Marketplace",
  };

  const response = await axios.post(
    `${process.env.MOMO_BASE_URL}/collection/v1_0/requesttopay`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Reference-Id": xReferenceId,
        "X-Target-Environment": process.env.MOMO_TARGET_ENV || "sandbox",
        "Ocp-Apim-Subscription-Key": process.env.MOMO_PRIMARY_KEY,
        "Content-Type": "application/json",
      },
    },
  );

  return {
    reference: xReferenceId,
    status: "PENDING",
    raw: response.data,
  };
};

// ---------------------------------------------------------------------------
// Internal helpers consumed by the polymorphic helper in payment.controller.js
// ---------------------------------------------------------------------------

function buildCollectionPayload({ amount, currency, msisdn, externalId, payerMessage, payeeNote }) {
  return {
    amount: String(amount),
    currency: currency || "RWF",
    externalId,
    payer: {
      partyIdType: "MSISDN",
      partyId: String(msisdn),
    },
    payer_message: payerMessage || `MVEC payment of RWF ${amount}`,
    payee_note: payeeNote || "MVEC Marketplace",
  };
}

/**
 * Trigger a USSD push payment request to the buyer's phone number.
 *
 * Maintains the interface consumed by the polymorphic helper in
 * payment.controller.js (triggerUssdPush({ amount, currency, phone, externalId })).
 */
async function triggerUssdPush({ amount, currency = "RWF", phone, externalId }) {
  const reference = externalId || generateExternalId();

  if (isSandbox()) {
    return {
      success: true,
      reference,
      status: "PENDING",
      raw: { sandbox: true, message: "USSD push simulated in sandbox mode" },
    };
  }

  const token = await getMomoAccessToken();
  const body = buildCollectionPayload({ amount, currency, msisdn: phone, externalId: reference });

  const res = await fetch(
    `${process.env.MOMO_BASE_URL}/collection/v1_0/requesttopay`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Reference-Id": reference,
        "X-Target-Environment": process.env.MOMO_TARGET_ENV || "sandbox",
        "Ocp-Apim-Subscription-Key": process.env.MOMO_PRIMARY_KEY,
      },
      body: JSON.stringify(body),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MoMo gateway request failed with status ${res.status}: ${text}`);
  }

  return {
    success: true,
    reference,
    status: "PENDING",
    raw: await res.json().catch(() => ({})),
  };
}

/**
 * Poll the gateway for the final status of a transaction.
 */
async function getTransactionStatus(externalId) {
  if (isSandbox()) {
    return { status: "SUCCESSFUL", reference: externalId };
  }

  const token = await getMomoAccessToken();

  const res = await fetch(
    `${process.env.MOMO_BASE_URL}/collection/v1_0/requesttopay/${externalId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Target-Environment": process.env.MOMO_TARGET_ENV || "sandbox",
        "Ocp-Apim-Subscription-Key": process.env.MOMO_PRIMARY_KEY,
      },
    },
  );
  if (!res.ok) return { status: "FAILED", reference: externalId };
  const data = await res.json().catch(() => ({}));
  return { status: data.status || "UNKNOWN", reference: externalId, raw: data };
}

module.exports = {
  isSandbox,
  generateExternalId,
  getMomoAccessToken,
  initiateMomoPayment,
  triggerUssdPush,
  getTransactionStatus,
};
