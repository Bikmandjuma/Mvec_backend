// K-Pay (Esicia, Rwanda) hosted payments: mobile money (MTN/Airtel), cards
// (Visa/Mastercard/Amex) and SPENN through one API.
// Docs: https://developers.kpay.africa/documentation.php
//
// Env: KPAY_API_KEY, KPAY_USERNAME, KPAY_PASSWORD, KPAY_RETAILER_ID,
//      optional KPAY_BASE_URL (default https://pay.esicia.com/),
//      API_PUBLIC_URL (where K-Pay can reach /api/webhooks/kpay), FRONTEND_URL.
// Without the credentials the service runs in sandbox mode (local
// development): payments succeed at once; production refuses sandbox payments.
//
// K-Pay has no refund API: card/SPENN refunds are done by an admin in the
// K-Pay merchant portal (MANUAL disbursements); mobile money refunds are sent
// back to the payer's number through Paypack.
const crypto = require("crypto");

const BASE_URL = () => process.env.KPAY_BASE_URL || "https://pay.esicia.com/";
const isSandbox = () => !(process.env.KPAY_API_KEY && process.env.KPAY_USERNAME && process.env.KPAY_PASSWORD && process.env.KPAY_RETAILER_ID);
const METHODS = { momo: "momo", card: "cc", cc: "cc", spenn: "spenn" };

async function call(body) {
  const auth = Buffer.from(`${process.env.KPAY_USERNAME}:${process.env.KPAY_PASSWORD}`).toString("base64");
  const res = await fetch(BASE_URL(), {
    method: "POST",
    headers: { "Kpay-Key": process.env.KPAY_API_KEY, Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.reply || data.statusmsg || `K-Pay request failed (${res.status})`), { statusCode: 502, gateway: data });
  return data;
}

/**
 * Start a payment. method: "momo" | "card" | "spenn".
 * Returns { reference: tid, checkoutUrl, status: "PENDING" | "SUCCESSFUL", raw }.
 */
async function pay({ refid, amount, method, msisdn, email, name, customerRef, details, returnUrl, redirectUrl }) {
  const pmethod = METHODS[String(method || "").toLowerCase()];
  if (!pmethod) throw Object.assign(new Error("Choose mobile money, card or SPENN."), { statusCode: 400 });
  if (isSandbox()) return { reference: `SANDBOX-KPAY-${crypto.randomUUID()}`, checkoutUrl: null, status: "SUCCESSFUL", raw: { sandbox: true } };

  const data = await call({
    action: "pay",
    msisdn: String(msisdn || "").replace(/^\+/, ""),
    email: email || "buyer@mvec.rw",
    details: String(details || "MVEC payment").slice(0, 120),
    refid,
    amount: Math.round(Number(amount)),
    currency: "RWF",
    cname: String(name || "MVEC buyer").slice(0, 80),
    cnumber: String(customerRef || refid),
    pmethod,
    retailerid: process.env.KPAY_RETAILER_ID,
    returl: returnUrl,
    redirecturl: redirectUrl,
  });
  if (Number(data.success) !== 1) {
    throw Object.assign(new Error(friendlyReply(data.reply)), { statusCode: 502, gateway: data });
  }
  return { reference: String(data.tid || ""), checkoutUrl: data.url || null, status: "PENDING", raw: data };
}

/** Latest status by our reference: { status: SUCCESSFUL|FAILED|PENDING, tid, raw }. */
async function checkStatus(refid) {
  if (isSandbox()) return { status: "SUCCESSFUL", tid: `SANDBOX-KPAY-${refid}`, raw: { sandbox: true } };
  const data = await call({ action: "checkstatus", refid });
  return { status: statusOf(data.statusid), tid: data.tid ? String(data.tid) : null, message: data.statusdesc || data.statusmsg || "", raw: data };
}

// K-Pay statusid: 01 success, 02 failed, 03 pending.
const statusOf = (id) => ({ "01": "SUCCESSFUL", "1": "SUCCESSFUL", "02": "FAILED", "2": "FAILED" })[String(id)] || "PENDING";

function friendlyReply(reply) {
  const r = String(reply || "").toUpperCase();
  if (r.includes("AUTHORIZATION")) return "K-Pay rejected MVEC's credentials. This is on our side; please pay another way for now.";
  if (r.includes("MSISDN") || r.includes("PHONE")) return "K-Pay could not use that phone number. Check it and try again.";
  return "K-Pay could not start the payment. No money was taken; please try again or choose another way to pay.";
}

module.exports = { isSandbox, pay, checkStatus, statusOf };
