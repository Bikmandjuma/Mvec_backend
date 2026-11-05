// Outbound email and SMS in one place, so every feature (password reset,
// order updates, payouts) uses the same providers and fails the same way.
//
// Email: Nodemailer with EMAIL_USER / EMAIL_PASS (Gmail or EMAIL_HOST SMTP).
// SMS:   SMS_PROVIDER = pindo | africastalking | log
//   pindo           PINDO_API_TOKEN, SMS_FROM_NAME          https://pindo.io
//   africastalking  AT_USERNAME, AT_API_KEY, SMS_FROM_NAME  https://africastalking.com
//   log             prints the message (development only)
const axios = require("axios");
const nodemailer = require("nodemailer");

const isProduction = () => process.env.NODE_ENV === "production";

// Tests never send real email (they stub the transport when they need it).
function emailConfigured() {
  if (process.env.NODE_ENV === "test") return false;
  return Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

function smsProvider() {
  const provider = (process.env.SMS_PROVIDER || "").trim().toLowerCase();
  if (provider === "pindo" && process.env.PINDO_API_TOKEN) return "pindo";
  if (provider === "africastalking" && process.env.AT_USERNAME && process.env.AT_API_KEY) return "africastalking";
  if (!isProduction() && (provider === "log" || !provider)) return "log";
  return null;
}

let transporter = null;
function getTransporter() {
  if (transporter) return transporter;
  const auth = { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS };
  transporter = process.env.EMAIL_HOST
    ? nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: Number(process.env.EMAIL_PORT) || 587,
      secure: process.env.EMAIL_SECURE === "true" || process.env.EMAIL_PORT === "465",
      auth,
    })
    : nodemailer.createTransport({ service: process.env.EMAIL_SERVICE || "Gmail", auth });
  return transporter;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * Send an email. Throws when email is not configured or the provider fails.
 * @param {{to: string, subject: string, text: string, action?: {label: string, url: string}}} msg
 */
async function sendEmail({ to, subject, text, action }) {
  if (!emailConfigured()) throw new Error("Email is not configured.");
  const from = process.env.EMAIL_FROM || process.env.EMAIL_USER;
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#16252d;line-height:1.55">
    <h2 style="color:#168db8;margin:0 0 12px">MVEC</h2>
    ${text.split("\n").map((line) => `<p style="margin:0 0 10px">${escapeHtml(line)}</p>`).join("")}
    ${action ? `<p><a href="${escapeHtml(action.url)}" style="background:#25addb;color:#fff;padding:11px 20px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:bold">${escapeHtml(action.label)}</a></p>` : ""}
    <p style="color:#71808a;font-size:12px;margin-top:24px">MVEC marketplace · Rwanda</p>
  </div>`;
  await getTransporter().sendMail({ from: `"MVEC" <${from}>`, to, subject, text, html });
}

/**
 * Send an SMS to a Rwandan number (+2507…). Throws when SMS is not available.
 * @param {string} phone
 * @param {string} text  keep under 160 characters where possible
 */
async function sendSms(phone, text) {
  const provider = smsProvider();
  if (!provider) throw new Error("SMS is not configured.");
  const sender = process.env.SMS_FROM_NAME || "MVEC";
  // Accounts store local numbers (0788…); gateways need +250788….
  const to = require("../utils/sms.util").normalizePhone(phone);
  if (!to) throw new Error(`Not a valid Rwandan phone number: ${phone}`);

  if (provider === "log") {
    console.log(`[SMS:log] to ${to}: ${text}`);
    return;
  }
  if (provider === "pindo") {
    await axios.post(
      "https://api.pindo.io/v1/sms/",
      { to, text, sender },
      { headers: { Authorization: `Bearer ${process.env.PINDO_API_TOKEN}` }, timeout: 15000 },
    );
    return;
  }
  if (provider === "africastalking") {
    const body = new URLSearchParams({ username: process.env.AT_USERNAME, to, message: text });
    if (process.env.SMS_FROM_NAME) body.set("from", sender);
    await axios.post("https://api.africastalking.com/version1/messaging", body.toString(), {
      headers: { apiKey: process.env.AT_API_KEY, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    });
  }
}

module.exports = { sendEmail, sendSms, emailConfigured, smsAvailable: () => Boolean(smsProvider()), smsProvider };
