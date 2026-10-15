// Card payments through Flutterwave's hosted checkout (Visa/Mastercard in RWF).
// The buyer types card details on Flutterwave's page, never on MVEC, and every
// result is verified with Flutterwave's API before an order is marked paid.
//
// Env: FLW_SECRET_KEY (live or test key), FLW_WEBHOOK_HASH (the "secret hash"
// set in the Flutterwave dashboard), optional FLW_BASE_URL.
// Without FLW_SECRET_KEY the service runs in sandbox mode (local development):
// payments and refunds succeed immediately; production refuses sandbox payments.
const crypto = require("crypto");

const BASE_URL = () => (process.env.FLW_BASE_URL || "https://api.flutterwave.com/v3").replace(/\/$/, "");
const isSandbox = () => !process.env.FLW_SECRET_KEY;

async function call(method, path, body) {
  const res = await fetch(`${BASE_URL()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${process.env.FLW_SECRET_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status === "error") {
    throw Object.assign(new Error(data.message || `Flutterwave request failed (${res.status})`), { statusCode: 502, gateway: data });
  }
  return data.data;
}

/** Hosted checkout link for one payment. */
async function createCheckout({ txRef, amount, customer = {}, redirectUrl, description }) {
  if (isSandbox()) return { link: null, sandbox: true };
  const data = await call("POST", "/payments", {
    tx_ref: txRef,
    amount,
    currency: "RWF",
    redirect_url: redirectUrl,
    payment_options: "card",
    customer: {
      email: customer.email || "buyer@mvec.rw",
      phonenumber: customer.phone || undefined,
      name: customer.name || "MVEC buyer",
    },
    customizations: { title: "MVEC", description: description || "MVEC order payment" },
  });
  return { link: data.link };
}

/**
 * Latest state of a payment, looked up by our reference.
 * Returns { status: "SUCCESSFUL" | "FAILED" | "PENDING", amount, fee, id, raw }.
 */
async function verifyByReference(txRef) {
  if (isSandbox()) return { status: "SUCCESSFUL", amount: null, fee: 0, id: `SANDBOX-${txRef}`, raw: { sandbox: true } };
  let data;
  try {
    data = await call("GET", `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`);
  } catch (err) {
    // No transaction yet: the buyer has not finished the checkout page.
    if (/no transaction/i.test(err.message)) return { status: "PENDING", raw: err.gateway };
    throw err;
  }
  const s = String(data.status || "").toLowerCase();
  return {
    status: s === "successful" ? "SUCCESSFUL" : s === "failed" || s === "cancelled" ? "FAILED" : "PENDING",
    amount: Number(data.amount),
    currency: data.currency,
    fee: Number(data.app_fee) || 0,
    id: String(data.id),
    raw: data,
  };
}

/** Refund (part of) a card payment to the same card. */
async function refund({ transactionId, amount }) {
  if (isSandbox()) return { status: "SUCCESSFUL", reference: `SANDBOX-REFUND-${crypto.randomUUID()}` };
  const data = await call("POST", `/transactions/${encodeURIComponent(transactionId)}/refund`, { amount });
  const s = String(data.status || "").toLowerCase();
  return { status: s === "completed" || s === "successful" ? "SUCCESSFUL" : s === "failed" ? "FAILED" : "PENDING", reference: String(data.id || ""), raw: data };
}

/** Current state of a refund started with refund(). */
async function refundStatus(refundId) {
  if (isSandbox()) return { status: "SUCCESSFUL" };
  const data = await call("GET", `/refunds/${encodeURIComponent(refundId)}`);
  const s = String(data.status || "").toLowerCase();
  return { status: s === "completed" || s === "successful" ? "SUCCESSFUL" : s === "failed" ? "FAILED" : "PENDING" };
}

/** Webhooks carry the dashboard "secret hash" in the verif-hash header. */
function verifyWebhook(headers) {
  const expected = process.env.FLW_WEBHOOK_HASH;
  const got = headers["verif-hash"];
  if (!expected || !got) return false;
  const a = Buffer.from(String(got));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { isSandbox, createCheckout, verifyByReference, refund, refundStatus, verifyWebhook };
