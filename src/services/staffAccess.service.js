// Vendor staff work inside their employer's shop. `protect` swaps req.user to
// the store owner for staff requests (so every seller endpoint reads and writes
// the owner's data) and checks the staff member's permissions here first.
// Auth routes keep the staff member's own account (profile, password).

const PERMISSIONS = [
  ["canViewDashboard", "Dashboard"],
  ["canManageProducts", "Products, categories, inventory & purchasing"],
  ["canManageOrders", "Orders, customers & disputes"],
  ["canManageMarketing", "Promotions, ads, reviews & affiliates"],
  ["canViewAnalytics", "Analytics & reports"],
  ["canManagePayouts", "Payouts, statement & subscription"],
  ["canManageSettings", "Stores, shipping & store settings"],
  ["canManageStaff", "Team (view and manage other staff)"],
];
const KEYS = PERMISSIONS.map(([k]) => k);

const ROLE_PRESETS = {
  STORE_MANAGER: ["canViewDashboard", "canManageProducts", "canManageOrders", "canManageMarketing", "canViewAnalytics", "canManageSettings"],
  ORDER_MANAGER: ["canViewDashboard", "canManageOrders"],
  CATALOG_MANAGER: ["canViewDashboard", "canManageProducts"],
  MARKETING_MANAGER: ["canViewDashboard", "canManageMarketing", "canViewAnalytics"],
  FINANCE_MANAGER: ["canViewDashboard", "canManagePayouts", "canViewAnalytics"],
};
const presetFor = (role) => Object.fromEntries(KEYS.map((k) => [k, (ROLE_PRESETS[role] || ROLE_PRESETS.ORDER_MANAGER).includes(k)]));

const ALWAYS = "ALWAYS";
const OWNER_ONLY = "OWNER_ONLY";
const READ = (m) => m === "GET" || m === "HEAD";

/**
 * Permission a staff request needs: a key, an array (any of), ALWAYS, or
 * OWNER_ONLY. base is the router mount (req.baseUrl), path the rest.
 */
function requiredPermission(method, base, path) {
  const read = READ(method);
  const p = path || "/";
  switch (base) {
    case "/api/auth": case "/api/notifications": case "/api/conversations": case "/api/support":
    case "/api/search": case "/api/uploads": case "/api/languages": case "/api/ads": case "/api/events":
      return ALWAYS;
    case "/api/staff": case "/api/vendor/staff":
      return "canManageStaff";
    case "/api/products":
      return read ? ["canManageProducts", "canManageOrders", "canManageMarketing", "canViewAnalytics"] : "canManageProducts";
    case "/api/categories":
      return read ? ALWAYS : "canManageProducts";
    case "/api/wholesale": case "/api/suppliers":
      return read ? ["canManageProducts", "canManagePayouts"] : "canManageProducts";
    case "/api/orders":
      return read ? ["canManageOrders", "canViewAnalytics", "canManagePayouts"] : "canManageOrders";
    case "/api/users":
      return read ? ["canManageOrders", "canViewAnalytics"] : "canManageOrders";
    case "/api/disputes":
      return "canManageOrders";
    case "/api/payouts":
      if (read && p.startsWith("/balance")) return ["canManagePayouts", "canViewAnalytics", "canManageMarketing"];
      return "canManagePayouts";
    case "/api/vendor":
      if (p.startsWith("/subscription")) return read ? ["canManagePayouts", "canViewAnalytics"] : "canManagePayouts";
      if (p.startsWith("/advertisements")) return read ? ["canManageMarketing", "canViewAnalytics", "canManagePayouts"] : "canManageMarketing";
      return OWNER_ONLY;
    case "/api/promotions":
      return read ? ["canManageMarketing", "canViewAnalytics"] : "canManageMarketing";
    case "/api/reviews":
      return read ? ["canManageMarketing", "canManageProducts", "canViewAnalytics"] : "canManageMarketing";
    case "/api/affiliates":
      return p.startsWith("/vendor") ? ["canManageMarketing", "canViewAnalytics"] : OWNER_ONLY;
    case "/api/reports":
      return "canViewAnalytics";
    case "/api/stores": case "/api/shipping": case "/api/vendors":
      return read ? ALWAYS : "canManageSettings";
    default:
      return read ? ALWAYS : OWNER_ONLY;
  }
}

function allowed(required, permissions = {}) {
  if (required === ALWAYS) return true;
  if (required === OWNER_ONLY) return false;
  const any = Array.isArray(required) ? required : [required];
  return any.some((k) => permissions[k] === true);
}

const LABEL = Object.fromEntries(PERMISSIONS);
function deniedMessage(required) {
  if (required === OWNER_ONLY) return "Only the store owner can do this.";
  const first = Array.isArray(required) ? required[0] : required;
  return `Your staff role doesn't include ${LABEL[first] || "this area"}. Ask the store owner for access.`;
}

// Short description of a write, for the activity log.
const ACTIONS = [
  [/^POST \/api\/products\/?$/, "Added a product"],
  [/^PUT \/api\/products\/[^/]+$/, "Edited a product"],
  [/^DELETE \/api\/products\/[^/]+$/, "Deleted a product"],
  [/^PATCH \/api\/products\/[^/]+\/stock$/, "Adjusted stock"],
  [/^POST \/api\/products\/vendor\/move-store$/, "Moved products to another store"],
  [/^POST \/api\/categories/, "Created a category"],
  [/^(PATCH|PUT) \/api\/categories/, "Edited a category"],
  [/^DELETE \/api\/categories/, "Deleted a category"],
  [/^PATCH \/api\/orders\/vendor\/status$/, "Updated an order status"],
  [/^POST \/api\/orders\/vendor\/manual$/, "Recorded a manual order"],
  [/^(PATCH|POST) \/api\/orders\//, "Updated an order"],
  [/^POST \/api\/disputes/, "Responded to a dispute"],
  [/^POST \/api\/payouts\/request$/, "Requested a payout"],
  [/^POST \/api\/payouts\/[^/]+\/cancel$/, "Cancelled a payout request"],
  [/^POST \/api\/promotions\/?$/, "Created a promotion"],
  [/^PATCH \/api\/promotions/, "Edited a promotion"],
  [/^DELETE \/api\/promotions/, "Deleted a promotion"],
  [/^POST \/api\/vendor\/advertisements\/?$/, "Started an ad campaign"],
  [/^(PATCH|POST) \/api\/vendor\/advertisements/, "Changed an ad campaign"],
  [/^POST \/api\/vendor\/subscription/, "Changed the subscription"],
  [/^POST \/api\/reviews\/[^/]+\/reply$/, "Replied to a review"],
  [/^POST \/api\/staff\/?$/, "Added a team member"],
  [/^(PUT|POST|DELETE) \/api\/staff\//, "Changed a team member"],
  [/\/api\/shipping/, "Changed shipping"],
  [/\/api\/stores/, "Changed store details"],
  [/\/api\/vendors/, "Changed the seller profile"],
  [/\/api\/wholesale/, "Updated a wholesale purchase"],
];
function describe(method, url) {
  const key = `${method} ${url.split("?")[0]}`;
  return ACTIONS.find(([re]) => re.test(key))?.[1] || `${method} ${url.split("?")[0].replace(/^\/api/, "")}`;
}

module.exports = { PERMISSIONS, KEYS, ROLE_PRESETS, presetFor, requiredPermission, allowed, deniedMessage, describe, ALWAYS, OWNER_ONLY };
