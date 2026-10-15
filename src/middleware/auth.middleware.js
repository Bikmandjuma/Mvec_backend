const jwt = require("jsonwebtoken");
const User = require("../models/User"); // Adjust path to your User model
const Staff = require("../models/Staff");
const StaffActivity = require("../models/StaffActivity");
const staffAccess = require("../services/staffAccess.service");

const ACTIVE_TOUCH_MS = 5 * 60 * 1000;

// For a staff login: check the staff record and permission for this route,
// then run the request as the store owner (auth routes stay on the staff
// account). Returns a response when access is denied, otherwise undefined.
async function applyStaffAccess(req, res) {
  const staff = await Staff.findOne({ user: req.user._id });
  if (!staff) {
    // A removed staff account must not fall back to being a seller of its own.
    if (req.user.isVendorStaff) return res.status(403).json({ message: "You no longer have access to this store." });
    return undefined;
  }
  if (staff.status !== "ACTIVE") {
    return res.status(403).json({ message: "Your access to this store is suspended. Contact the store owner." });
  }
  const base = req.baseUrl || "";
  const required = staffAccess.requiredPermission(req.method, base, req.path);
  const permissions = staff.permissions?.toObject?.() || staff.permissions || {};
  if (!staffAccess.allowed(required, permissions)) {
    return res.status(403).json({ message: staffAccess.deniedMessage(required), code: "STAFF_PERMISSION" });
  }

  req.staffMember = staff;
  req.staffUser = req.user;
  if (base !== "/api/auth") {
    const owner = await User.findById(staff.vendorOwner).select("-password");
    if (!owner || (owner.status && owner.status !== "ACTIVE")) {
      return res.status(403).json({ message: "This store is not available right now." });
    }
    req.user = owner;
  }

  const now = Date.now();
  if (!staff.lastActiveAt || now - new Date(staff.lastActiveAt).getTime() > ACTIVE_TOUCH_MS) {
    Staff.updateOne({ _id: staff._id }, { $set: { lastActiveAt: new Date(now) } }).catch(() => {});
  }
  // Log store changes (not the staff member's own account actions).
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && base !== "/api/auth" && base !== "/api/notifications") {
    const url = req.originalUrl;
    res.on("finish", () => {
      if (res.statusCode >= 400) return;
      StaffActivity.create({
        vendor: staff.vendorOwner, user: req.staffUser._id, staff: staff._id,
        action: staffAccess.describe(req.method, url), method: req.method,
        path: url.split("?")[0].slice(0, 300), statusCode: res.statusCode,
      }).catch(() => {});
    });
  }
  return undefined;
}
const Vendor = require("../models/Vendor");
const Supplier = require("../models/Supplier");
const SupplierTeamMember = require("../models/SupplierTeamMember");

const issuedBeforePasswordChange = (decoded, user) =>
  Boolean(user?.lastPasswordChangeAt && decoded?.iat && decoded.iat * 1000 < new Date(user.lastPasswordChangeAt).getTime() - 1000);

exports.protect = async (req, res, next) => {
  // Some routes apply protect at router and route level; authenticate once so
  // a staff request keeps running as the store owner.
  if (req.authenticated) return next();
  let token;

  // 1. Check if Authorization header exists and starts with 'Bearer'
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    try {
      // Extract token string (e.g., "Bearer eyJhbGciOi...")
      token = req.headers.authorization.split(" ")[1];

      // 2. Verify token signature and expiration
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // 3. Attach user data to request object (excluding password)
      req.user = await User.findById(decoded.userId || decoded.id).select("-password +isVendorStaff");

      if (!req.user) {
        return res.status(401).json({ message: "User no longer exists" });
      }
      // Tokens from before a password change / "sign out everywhere" are revoked.
      if (req.user.tokensValidAfter && decoded.iat && decoded.iat * 1000 < new Date(req.user.tokensValidAfter).getTime()) {
        return res.status(401).json({ message: "Your session ended. Please sign in again.", code: "SESSION_REVOKED" });
      }
      // A blocked or suspended account loses access at once, not when its token expires.
      if (["BLOCK", "BLOCKED", "SUSPEND", "SUSPENDED"].includes(String(req.user.status || "ACTIVE").toUpperCase())) {
        return res.status(403).json({ message: "Your account is blocked or suspended. Contact MVEC support.", code: "ACCOUNT_BLOCKED" });
      }
      // Any other non-active status (e.g. a suspended staff account) is also refused.
      if (req.user.status && req.user.status !== "ACTIVE") {
        return res.status(403).json({ message: "This account is suspended. Contact the store owner or support.", code: "ACCOUNT_BLOCKED" });
      }

      // Sessions created before the latest password change are revoked.
      if (issuedBeforePasswordChange(decoded, req.user)) {
        return res.status(401).json({ message: "Your password was changed. Please log in again." });
      }

      // 4. Vendor staff act inside their employer's shop.
      if (req.user.role === "vendor") {
        const denied = await applyStaffAccess(req, res);
        if (denied) return denied;
      }

      // Proceed to the next middleware or controller
      req.authenticated = true;
      return next();
    } catch (error) {
      console.error("Auth Middleware Error:", error.message);
      return res.status(401).json({ message: "Not authorized, token failed" });
    }
  }

  // If no token is provided in the headers
  if (!token) {
    return res.status(401).json({ message: "Not authorized, no token provided" });
  }
};

// Attaches req.user when a valid token is present but never rejects the request
// (public endpoints that behave slightly differently for signed-in users).
exports.optionalProtect = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (header && header.startsWith("Bearer")) {
      const decoded = jwt.verify(header.split(" ")[1], process.env.JWT_SECRET);
      req.user = await User.findById(decoded.userId || decoded.id).select("-password");
      if (issuedBeforePasswordChange(decoded, req.user)) req.user = undefined;
    }
  } catch (error) {
    req.user = undefined;
  }
  next();
};

// Restrict endpoint access to specific roles
exports.authorize = (...roles) => {
  return (req, res, next) => {
    const isAdminSeller = req.user.role === "super_admin" && req.user.isSellerEnabled;
    if (!roles.includes(req.user.role) && !(isAdminSeller && roles.includes("vendor"))) {
      return res.status(403).json({
        message: `User role '${req.user.role}' is not authorized to access this route`,
      });
    }
    next();
  };
};

exports.requireOnboarded = async (req, res, next) => {
  if (!["vendor", "supplier"].includes(req.user.role) || (req.user.role === "super_admin" && req.user.isSellerEnabled)) return next();
  const Profile = req.user.role === "vendor" ? Vendor : Supplier;
  let profile = await Profile.findOne({ user: req.user._id }).lean();

  // Vendor team/staff accounts never onboard themselves. They inherit the
  // onboarding state of the owner who invited them, so a staff member of an
  // already onboarded vendor is onboarded too.
  if (!profile && req.user.role === "vendor") {
    const membership = await Staff.findOne({
      $or: [{ user: req.user._id }, { user_id: req.user._id }],
      status: "ACTIVE",
    }).lean();
    if (membership) profile = await Vendor.findOne({ user: membership.vendorOwner }).lean();
  }

  if (!profile && req.user.role === "supplier") {
    const membership = await SupplierTeamMember.findOne({ user: req.user._id, status: "ACTIVE" }).lean();
    if (membership) profile = await Supplier.findById(membership.supplier).lean();
  }
  const complete = Boolean(profile?.businessName && profile?.email && profile?.phone && profile?.description && profile?.logoUrl && profile?.category && profile?.location);
  if (!complete) {
    return res.status(403).json({ message: "Complete onboarding before using this action.", code: "ONBOARDING_REQUIRED" });
  }
  return next();
};
