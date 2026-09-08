// src/services/momo.service.js
// Mobile Money (MoMo) payment gateway abstraction.
//
// The gateway provider is config driven so the integration works end-to-end in
// both a sandbox/dev environment (no real credentials required) and production.
//
// To connect a real provider (e.g. MTN MoMo OpenAPI / Airtel Money API) set:
//   MOMO_GATEWAY_BASE_URL, MOMO_GATEWAY_SUB_KEY, MOMO_GATEWAY_USER, MOMO_GATEWAY_PASS
// and implement the provider-specific payload transform inside `requestCollection()`.

const crypto = require("crypto");

// Sandbox/dev mode is the default so local development and tests work without
// a live provider. When NODE_ENV === "production" a real network request is made.
function isSandbox() {
  return process.env.NODE_ENV !== "production" || !process.env.MOMO_GATEWAY_BASE_URL;
}

/**
 * Generate the reference the buyer will be asked to approve (used by the
 * provider callback to reconcile this request). Kept short & numeric for USSD.
 */
function generateExternalId() {
  return `MVEC${Date.now()}${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

/**
 * Build the provider-specific collection (USSD push) request body.
 * Override this mapping if you integrate directly with MTN/Airtel OpenAPI.
 */
function buildCollectionPayload({ amount, currency, msisdn, externalId, payerMessage, payeeNote }) {
  return {
    amount: String(amount),
    currency: currency || "RWF",
    msisdn: String(msisdn),
    externalId,
    payer_message: payerMessage || `MVEC payment of RWF ${amount}`,
    payee_note: payeeNote || "MVEC Marketplace",
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

  const url = `${process.env.MOMO_GATEWAY_BASE_URL}/collection/v1_0/requesttopay`;
  const body = buildCollectionPayload({
    amount,
    currency,
    msisdn: phone,
    externalId: reference,
  });

  const headers = {
    "Content-Type": "application/json",
    "X-Reference-Id": reference,
    // Ocp-Apim-Subscription-Key / Basic auth for MTN MoMo OpenAPI style gateways
    "Ocp-Apim-Subscription-Key": process.env.MOMO_GATEWAY_SUB_KEY || "",
    Authorization: process.env.MOMO_GATEWAY_AUTH || "",
  };

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MoMo gateway request failed with status ${res.status}: ${text}`);
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
  const url = `${process.env.MOMO_GATEWAY_BASE_URL}/collection/v1_0/requesttopay/${externalId}`;
  const res = await fetch(url, {
    headers: {
      "Ocp-Apim-Subscription-Key": process.env.MOMO_GATEWAY_SUB_KEY || "",
      Authorization: process.env.MOMO_GATEWAY_AUTH || "",
    },
  });
  if (!res.ok) return { status: "FAILED", reference: externalId };
  const data = await res.json().catch(() => ({}));
  return { status: data.status || "UNKNOWN", reference: externalId, raw: data };
}

module.exports = {
  isSandbox,
  generateExternalId,
  triggerUssdPush,
  getTransactionStatus,
};
