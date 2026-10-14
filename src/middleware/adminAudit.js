// Records every successful change an administrator makes (verifications,
// suspensions, refunds, payouts, disputes, ads…) in the audit log, without any
// route having to remember to do it. Runs after the response is sent, so it
// never slows a request down or breaks it.
const AuditLog = require("../models/AuditLog");

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Not worth auditing: the admin's own session, chats, reading notifications, uploads.
const SKIP = [/^\/api\/auth\//, /^\/api\/conversations/, /^\/api\/notifications/, /^\/api\/uploads/, /^\/api\/support\/cases\/[^/]+\/comments/];
const SECRET = /pass(word)?|token|otp|secret|code|pin/i;

const lower = (v) => String(v || "").toLowerCase().replaceAll("_", " ");
// [method, path pattern, target type, label(body, match)]
const RULES = [
  ["PATCH", /^\/api\/admin\/vendors\/([^/]+)\/verify$/, "Seller", (b) => `Seller ${lower(b.decision)}`],
  ["PATCH", /^\/api\/admin\/vendors\/([^/]+)\/status$/, "Seller", (b) => `Seller account set to ${lower(b.status)}`],
  ["PATCH", /^\/api\/admin\/suppliers\/supply-requests\/([^/]+)$/, "Supply request", (b) => `Supply request ${lower(b.status)}`],
  ["PATCH", /^\/api\/admin\/suppliers\/payouts\/([^/]+)$/, "Supplier payout", (b) => `Supplier payout ${lower(b.status)}`],
  ["PATCH", /^\/api\/admin\/suppliers\/([^/]+)\/verify$/, "Supplier", (b) => `Supplier ${lower(b.decision)}`],
  ["PATCH", /^\/api\/admin\/suppliers\/([^/]+)\/status$/, "Supplier", (b) => `Supplier account set to ${lower(b.status)}`],
  ["PATCH", /^\/api\/users\/([^/]+)$/, "User", (b) => (b.status ? `User account set to ${lower(b.status)}` : "User account updated")],
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
  ["POST", /^\/api\/admin\/commissions$/, "Commission rule", () => "Commission rule created"],
  ["PATCH", /^\/api\/admin\/commissions\/([^/]+)\/toggle$/, "Commission rule", () => "Commission rule switched on/off"],
];

function describe(method, path, body) {
  for (const [m, re, targetType, label] of RULES) {
    const match = m === method && path.match(re);
    if (match) return { action: label(body || {}, match), targetType, targetId: match[1] || "" };
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
