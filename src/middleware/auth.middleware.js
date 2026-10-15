const jwt = require("jsonwebtoken");
const User = require("../models/User"); // Adjust path to your User model
const Staff = require("../models/Staff");
const Vendor = require("../models/Vendor");
const Supplier = require("../models/Supplier");
const SupplierTeamMember = require("../models/SupplierTeamMember");

const issuedBeforePasswordChange = (decoded, user) =>
  Boolean(user?.lastPasswordChangeAt && decoded?.iat && decoded.iat * 1000 < new Date(user.lastPasswordChangeAt).getTime() - 1000);

exports.protect = async (req, res, next) => {
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
      req.user = await User.findById(decoded.userId || decoded.id).select("-password");

      if (!req.user) {
        return res.status(401).json({ message: "User no longer exists" });
      }

      // A blocked or suspended account loses access at once, not when its token expires.
      if (["BLOCK", "BLOCKED", "SUSPEND", "SUSPENDED"].includes(String(req.user.status || "ACTIVE").toUpperCase())) {
        return res.status(403).json({ message: "Your account is blocked or suspended. Contact MVEC support.", code: "ACCOUNT_BLOCKED" });
      }

      // Sessions created before the latest password change are revoked.
      if (issuedBeforePasswordChange(decoded, req.user)) {
        return res.status(401).json({ message: "Your password was changed. Please log in again." });
      }

      // 4. Proceed to the next middleware or controller
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
