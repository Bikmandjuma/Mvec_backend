// Records every successful change an administrator makes (verifications,
// suspensions, refunds, payouts, disputes, ads…) in the audit log, without any
// route having to remember to do it. Runs after the response is sent, so it
// never slows a request down or breaks it.
const AuditLog = require("../models/AuditLog");

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Not worth auditing: the admin's own session, chats, reading notifications, uploads.
const SKIP = [/^\/api\/auth\//, /^\/api\/conversations/, /^\/api\/notifications/, /^\/api\/uploads/, /^\/api\/support\/cases\/[^/]+\/comments/,
  // An admin shopping as a buyer is not an administrative change.
  /^\/api\/cart/, /^\/api\/orders\/(checkout|direct-checkout)$/, /^\/api\/shipping\/quote$/, /^\/api\/payments\//,
  /^\/api\/promotions\/validate/, /^\/api\/vendors\/[^/]+\/follow$/, /^\/api\/reviews\/?$/];
const SECRET = /pass(word)?|token|otp|secret|code|pin/i;

const lower = (v) => String(v || "").toLowerCase().replaceAll("_", " ");
// [method, path pattern, target type, label(body, match)]
const RULES = [
  ["PATCH", /^\/api\/orders\/vendor\/status$/, "Order", (b) => `Order moved to ${lower(b.status) || "next step"}`],
  ["PATCH", /^\/api\/orders\/([^/]+)\/status$/, "Order", (b) => `Order status set to ${lower(b.status)}`],
  ["PATCH", /^\/api\/orders\/([^/]+)\/deliver$/, "Order", () => "Delivery confirmed with the buyer's code"],
  ["PATCH", /^\/api\/orders\/([^/]+)\/courier$/, "Order", (b) => (b.courierId ? "Courier assigned" : "Courier removed")],
  ["PATCH", /^\/api\/orders\/([^/]+)\/out-for-delivery$/, "Order", () => "Order marked out for delivery"],
  ["POST", /^\/api\/orders\/([^/]+)\/cancel$/, "Order", () => "Order cancelled"],
  ["POST", /^\/api\/vendors\/become-seller$/, "Seller mode", () => "Seller mode activated for the admin account"],
  ["POST", /^\/api\/admin\/vendor-payouts\/([^/]+)\/approve$/, "Seller payout", () => "Seller withdrawal approved"],
  ["POST", /^\/api\/admin\/vendor-payouts\/([^/]+)\/mark-paid$/, "Seller payout", (b) => `Seller withdrawal marked paid${b.reference ? ` (ref ${b.reference})` : ""}`],
  ["POST", /^\/api\/admin\/vendor-payouts\/([^/]+)\/reject$/, "Seller payout", () => "Seller withdrawal rejected"],
  ["PATCH", /^\/api\/admin\/vendors\/([^/]+)\/verify$/, "Seller", (b) => `Seller ${lower(b.decision)}`],
  ["PATCH", /^\/api\/admin\/vendors\/([^/]+)\/status$/, "Seller", (b) => `Seller account set to ${lower(b.status)}`],
  ["PATCH", /^\/api\/admin\/suppliers\/supply-requests\/([^/]+)$/, "Supply request", (b) => `Supply request ${lower(b.status)}`],
  ["PATCH", /^\/api\/admin\/suppliers\/payouts\/([^/]+)$/, "Supplier payout", (b) => `Supplier payout ${lower(b.status)}`],
  ["PATCH", /^\/api\/admin\/suppliers\/([^/]+)\/verify$/, "Supplier", (b) => `Supplier ${lower(b.decision)}`],
  ["PATCH", /^\/api\/admin\/suppliers\/([^/]+)\/status$/, "Supplier", (b) => `Supplier account set to ${lower(b.status)}`],
  ["PATCH", /^\/api\/users\/([^/]+)$/, "User", (b) => (b.status ? `User account set to ${lower(b.status)}` : "User account updated")],
  ["POST", /^\/api\/users\/couriers$/, "User", (b) => `Courier added: ${b.fullName || b.email}`],
  ["POST", /^\/api\/users\/admins$/, "User", (b) => `Admin added: ${b.fullName || b.email}`],
  ["POST", /^\/api\/users\/([^/]+)\/admin-access$/, "User", (b) => (b.active ? "Admin access restored" : "Admin access removed")],
  ["POST", /^\/api\/disputes\/([^/]+)\/decide$/, "Dispute", (b) => `Problem report decided: ${b.decision === "REFUND_BUYER" ? "buyer refunded" : b.decision === "RELEASE_TO_VENDOR" ? "seller paid" : `split (${b.buyerRefundAmount} RWF refunded, ${b.vendorReleaseAmount} RWF to seller)`}`],
  ["POST", /^\/api\/disputes\/([^/]+)\/arbitrate$/, "Dispute", (b) => `Dispute decided: ${lower(b.resolution || b.decision || b.outcome || "resolved")}`],
  ["PATCH", /^\/api\/admin\/settlements\/([^/]+)\/hold$/, "Settlement", () => "Seller payment put on hold"],
  ["DELETE", /^\/api\/admin\/settlements\/([^/]+)\/hold$/, "Settlement", () => "Hold on seller payment removed"],
  ["POST", /^\/api\/admin\/settlements\/([^/]+)\/release$/, "Settlement", () => "Seller payment released by hand"],
  ["PATCH", /^\/api\/admin\/advertisements\/([^/]+)\/status$/, "Advertisement", (b) => `Advertisement ${lower(b.status)}`],
  ["PATCH", /^\/api\/admin\/subscriptions\/([^/]+)\/status$/, "Subscription", (b) => `Subscription ${lower(b.status)}`],
  ["POST", /^\/api\/admin\/disbursements\/([^/]+)\/done$/, "Transfer", () => "Manual refund marked as sent"],
  ["POST", /^\/api\/admin\/disbursements\/([^/]+)\/retry$/, "Transfer", () => "Transfer retried"],
  ["POST", /^\/api\/affiliates\/payouts\/([^/]+)\/process$/, "Affiliate withdrawal", (b) => `Affiliate withdrawal ${lower(b.action || b.status || "processed")}`],
  ["PATCH", /^\/api\/abuse-reports\/([^/]+)$/, "Abuse report", (b) => `Abuse report ${lower(b.status || "updated")}`],
  ["PATCH", /^\/api\/support\/cases\/([^/]+)\/status$/, "Support request", (b) => `Support request ${lower(b.status)}`],
  ["POST", /^\/api\/categories\/?$/, "Category", (b) => `Category created: ${b.name || ""}`.trim()],
  ["PATCH", /^\/api\/categories\/([^/]+)$/, "Category", () => "Category updated"],
  ["DELETE", /^\/api\/categories\/([^/]+)$/, "Category", () => "Category disabled"],
  ["POST", /^\/api\/wholesale\/admin\/orders\/([^/]+)\/resolve$/, "Wholesale order", (b) => (String(b.decision).toUpperCase() === "RELEASE" ? "Wholesale dispute: supplier paid" : "Wholesale dispute: vendor refunded")],
  ["POST", /^\/api\/wholesale\/orders\/([^/]+)\/cancel$/, "Wholesale order", () => "Wholesale order cancelled by an admin"],
  ["POST", /^\/api\/wholesale\/orders\/([^/]+)\/hold-escrow$/, "Wholesale order", () => "Wholesale order marked as paid by hand"],
  ["POST", /^\/api\/admin\/payouts\/request$/, "MVEC wallet", (b) => `MVEC withdrawal recorded: ${b.amount} RWF to ${b.destination || ""}`],
  ["POST", /^\/api\/admin\/commissions$/, "Commission rule", (b) => `Commission rule created: ${b.rateValue ?? ""}%`],
  ["PATCH", /^\/api\/admin\/commissions\/([^/]+)\/toggle$/, "Commission rule", (b) => (b.isActive === false ? "Commission rule deactivated" : b.isActive === true ? "Commission rule activated" : "Commission rule switched on/off")],
  ["PUT", /^\/api\/admin\/commissions\/([^/]+)$/, "Commission rule", (b) => `Commission rule edited${b.rateValue !== undefined ? `: ${b.rateValue}%` : ""}`],
  ["DELETE", /^\/api\/admin\/commissions\/([^/]+)$/, "Commission rule", () => "Commission rule deleted"],
  ["PUT", /^\/api\/admin\/commission-settings$/, "Commission settings", () => "Commission settings changed"],
  ["PUT", /^\/api\/admin\/operations-settings$/, "Platform settings", (b) => [
    b.autoReleaseDays !== undefined ? `automatic release after ${b.autoReleaseDays} day(s)` : "",
    b.disputeResponseDays !== undefined ? `sellers answer problem reports within ${b.disputeResponseDays} day(s)` : "",
    b.subscriptionsEnabled !== undefined ? `subscription program ${b.subscriptionsEnabled ? "switched ON" : "switched off"}` : "",
    b.sellerPremiumPrice !== undefined ? `Seller Premium ${b.sellerPremiumPrice} RWF` : "",
    b.buyerPremiumPrice !== undefined ? `Buyer Premium ${b.buyerPremiumPrice} RWF` : "",
    b.freeProductLimit !== undefined ? `Free listing limit ${b.freeProductLimit}` : "",
  ].filter(Boolean).join(", ").replace(/^./, (c) => c.toUpperCase()) || "Platform settings changed"],
];

function describe(method, path, body) {
  for (const [m, re, targetType, label] of RULES) {
    const match = m === method && path.match(re);
    if (match) return { action: label(body || {}, match), targetType, targetId: match[1] || body?.orderId || "" };
  }
  return { action: `${method} ${path}`, targetType: "", targetId: "" };
}

function cleanBody(body) {
  if (!body || typeof body !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(body).slice(0, 20)) {
    if (SECRET.test(k)) continue;
    out[k] = typeof v === "string" ? v.slice(0, 300) : v;
  }
  const json = JSON.stringify(out);
  return json.length > 2000 ? { note: "Too large to store." } : out;
}

module.exports = function adminAudit(req, res, next) {
  if (!MUTATING.has(req.method)) return next();
  res.on("finish", () => {
    const user = req.user;
    const path = (req.originalUrl || "").split("?")[0];
    if (!user || user.role !== "super_admin" || res.statusCode >= 400 || SKIP.some((re) => re.test(path))) return;
    const { action, targetType, targetId } = describe(req.method, path, req.body);
    AuditLog.create({
      actor: user._id || user.id,
      actorName: user.Fullname || user.email || "",
      action: action.slice(0, 200),
      method: req.method,
      path: path.slice(0, 300),
      targetType,
      targetId: String(targetId).slice(0, 60),
      statusCode: res.statusCode,
      detail: cleanBody(req.body),
      ip: String(req.ip || "").slice(0, 60),
    }).catch((err) => console.error("Audit log failed:", err.message));
  });
  next();
};

module.exports.describe = describe;
