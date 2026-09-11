// src/services/airtel.service.js
// Airtel Money payment gateway abstraction.
//
// Mirrors momo.service.js so the collection (USSD push) flow works end-to-end
// in both sandbox/dev (no real credentials required) and production.
//
// To connect a real provider (e.g. Airtel Money OpenAPI) set:
//   AIRTEL_GATEWAY_BASE_URL, AIRTEL_GATEWAY_CLIENT_ID, AIRTEL_GATEWAY_CLIENT_SECRET,
//   AIRTEL_GATEWAY_ACCOUNT
// and implement the provider-specific payload transform inside `requestCollection()`.

const crypto = require("crypto");
const axios = require("axios");
const NodeCache = require("node-cache");
const tokenCache = new NodeCache({ stdTTL: 3300 });

const getAirtelAccessToken = async () => {
  const cachedToken = tokenCache.get("airtel_access_token");
  if (cachedToken) return cachedToken;

  const authResponse = await axios.post(
    `${process.env.AIRTEL_BASE_URL}/auth/oauth2/token`,
    {
      client_id: process.env.AIRTEL_CLIENT_ID,
      client_secret: process.env.AIRTEL_CLIENT_SECRET,
      grant_type: "client_credentials",
    }
  );

  const token = authResponse.data.access_token || authResponse.data.data?.access_token;
  if (!token) throw new Error("Failed to retrieve access token from Airtel.");

  tokenCache.set("airtel_access_token", token);
  return token;
};

// services/airtel.service.js
exports.checkTransactionStatus = async (transactionId) => {
  const token = await getAirtelAccessToken();

  const response = await axios.get(
    `${process.env.AIRTEL_BASE_URL}/standard/v1/payments/${transactionId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Country": process.env.AIRTEL_COUNTRY || "RWA",
        "X-Currency": process.env.AIRTEL_CURRENCY || "RWF",
      },
    }
  );

  return response.data; // Returns status: SUCCESS, FAILED, or IN_PROGRESS
};

// Determine base URL dynamically based on environment
const AIRTEL_BASE_URL = process.env.NODE_ENV === "production"
  ? "https://openapi.airtel.africa"
  : "https://openapiuat.airtel.africa"; // Sandbox environment endpoint

/**
 * Initiates an Airtel Mobile Money USSD Push prompt to the subscriber's handset.
 * 
 * @param {Object} params
 * @param {string} params.phoneNumber - Subscriber phone number (e.g. "78XXXXXXX" or "078XXXXXXX")
 * @param {number} params.amount - Transaction amount
 * @param {string} params.reference - Internal transaction/payment reference ID
 */
exports.initiateAirtelUssdPush = async ({ phoneNumber, amount, reference }) => {
  try {
    // 1. Sanitize Phone Number (Ensure MSISDN format without leading + or 0 if required)
    const cleanMsisdn = String(phoneNumber).replace(/^\+?250|^0/, "");

    // 2. Fetch OAuth2 Access Token
    const authResponse = await axios.post(
      `${AIRTEL_BASE_URL}/auth/oauth2/token`,
      {
        client_id: process.env.AIRTEL_CLIENT_ID,
        client_secret: process.env.AIRTEL_CLIENT_SECRET,
        grant_type: "client_credentials",
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    const accessToken = authResponse.data.access_token || authResponse.data.data?.access_token;

    if (!accessToken) {
      throw new Error("Failed to retrieve Airtel OAuth access token.");
    }

    // 3. Construct Payment Payload
    const paymentPayload = {
      reference: reference,
      subscriber: {
        country: process.env.AIRTEL_COUNTRY || "RWA",
        currency: process.env.AIRTEL_CURRENCY || "RWF",
        msisdn: cleanMsisdn,
      },
      transaction: {
        amount: Number(amount),
        country: process.env.AIRTEL_COUNTRY || "RWA",
        currency: process.env.AIRTEL_CURRENCY || "RWF",
        id: reference,
      },
    };

    // 4. Send USSD Payment Request to Airtel Gateway
    const response = await axios.post(
      `${AIRTEL_BASE_URL}/merchant/v1/payments/`,
      paymentPayload,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Country": process.env.AIRTEL_COUNTRY || "RWA",
          "X-Currency": process.env.AIRTEL_CURRENCY || "RWF",
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    return response.data;
  } catch (error) {
    console.error("[Airtel USSD Push Error]:", error.response?.data || error.message);
    throw new Error(
      error.response?.data?.status?.message ||
      error.response?.data?.message ||
      "Failed to trigger Airtel USSD push."
    );
  }
};

// Sandbox/dev mode is the default so local development and tests work without
// a live provider. When NODE_ENV === "production" a real network request is made.
function isSandbox() {
  return process.env.NODE_ENV !== "production" || !process.env.AIRTEL_GATEWAY_BASE_URL;
}

/**
 * Generate the reference the buyer will be asked to approve (used by the
 * provider callback to reconcile this request). Kept short & numeric for USSD.
 */
function generateExternalId() {
  return `AIRTEL${Date.now()}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

/**
 * Build the provider-specific collection (USSD push) request body for Airtel.
 * Override this mapping if you integrate directly with Airtel Money OpenAPI.
 */
function buildCollectionPayload({ amount, currency, msisdn, externalId, message }) {
  return {
    reference: externalId,
    subscriber: { country: "RW", currency: currency || "RWF", msisdn: String(msisdn) },
    transaction: { amount: String(amount), country: "RW", currency: currency || "RWF", id: externalId },
    message: message || "MVEC Marketplace payment",
  };
}

/**
 * Trigger a USSD push payment request to the buyer's phone number.
 *
 * @returns {Promise<{success: boolean, externalId: string, status: string, raw: object}>}
 */
async function triggerUssdPush({ amount, currency = "RWF", phone, externalId }) {
  const reference = externalId || generateExternalId();

  if (isSandbox()) {
    // Simulated push so the flow can run in dev/tests without a live gateway.
    return {
      success: true,
      reference,
      status: "PENDING",
      raw: { sandbox: true, message: "USSD push simulated in sandbox mode" },
    };
  }

  // Airtel Money OpenAPI style 2-legged OAuth token then collection request.
  const tokenRes = await fetch(`${process.env.AIRTEL_GATEWAY_BASE_URL}/auth/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.AIRTEL_GATEWAY_CLIENT_ID || "",
      client_secret: process.env.AIRTEL_GATEWAY_CLIENT_SECRET || "",
      grant_type: "client_credentials",
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Airtel gateway auth failed with status ${tokenRes.status}`);
  }
  const tokenData = await tokenRes.json().catch(() => ({ access_token: "" }));

  const url = `${process.env.AIRTEL_GATEWAY_BASE_URL}/merchant/v2/payments/`;
  const body = buildCollectionPayload({
    amount,
    currency,
    msisdn: phone,
    externalId: reference,
  });

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${tokenData.access_token}`,
    "X-Country": "RW",
    "X-Currency": currency || "RWF",
  };

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Airtel gateway request failed with status ${res.status}: ${text}`);
  }

  return { success: true, reference, status: "PENDING", raw: await res.json().catch(() => ({})) };
}

/**
 * Optionally poll the gateway for the final status of a transaction.
 * Returns the provider status string when a real gateway is configured.
 */
async function getTransactionStatus(externalId) {
  if (isSandbox()) {
    return { status: "SUCCESSFUL", reference: externalId };
  }
  const url = `${process.env.AIRTEL_GATEWAY_BASE_URL}/merchant/v2/payments/${externalId}`;
  const tokenRes = await fetch(`${process.env.AIRTEL_GATEWAY_BASE_URL}/auth/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.AIRTEL_GATEWAY_CLIENT_ID || "",
      client_secret: process.env.AIRTEL_GATEWAY_CLIENT_SECRET || "",
      grant_type: "client_credentials",
    }),
  }).catch(() => ({ ok: false }));
  let token = "";
  if (tokenRes.ok) {
    const data = await tokenRes.json().catch(() => ({ access_token: "" }));
    token = data.access_token || "";
  }
  const res = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Country": "RW",
      "X-Currency": "RWF",
    },
  });
  if (!res.ok) return { status: "FAILED", reference: externalId };
  const data = await res.json().catch(() => ({}));
  return { status: data.status_code === "TS" ? "SUCCESSFUL" : data.status_code || "UNKNOWN", reference: externalId, raw: data };
}

module.exports = {
  isSandbox,
  generateExternalId,
  triggerUssdPush,
  getTransactionStatus,
};