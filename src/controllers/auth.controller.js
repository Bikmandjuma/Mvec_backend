const bcrypt = require("bcryptjs");
const orm = require("../database/orm");
const express = require("express");
const User = require("../models/User");
const Otp = require("../models/Otp");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const {
  normalizePhone,
  phoneVariants,
  generateOtpCode,
  describePhoneIssue,
} = require("../utils/sms.util");
const vendorStaffInvitation = require("../services/vendorStaffInvitation.service");

// ─── HELPER: GOOGLE OAUTH CLIENT ─────────────────────────────────────────────
const getGoogleClient = () => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error(
      "GOOGLE_CLIENT_ID is not configured. Add it to your .env file."
    );
  }
  return new OAuth2Client(clientId);
};

// ─── HELPER: SIGN JWT & BUILD SANITIZED USER RESPONSE ───────────────────────
const Staff = require("../models/Staff");
const Vendor = require("../models/Vendor");
const Supplier = require("../models/Supplier");
const SupplierTeamMember = require("../models/SupplierTeamMember");

const getStaffDetailsForUser = async (userId) => {
  try {
    const staffMember = await Staff.findOne({
      $or: [{ user: userId }, { user_id: userId }],
      status: "ACTIVE",
    }).populate("store");
    if (!staffMember) return null;
    const permissions = staffMember.permissions?.toObject?.() || staffMember.permissions || {};
    const permissionsList = Object.entries(permissions).filter(([, v]) => v).map(([k]) => k);
    const storeId = staffMember.store?._id || staffMember.store;
    return {
      staffMember,
      storeId: storeId ? storeId.toString() : null,
      staffRole: staffMember.role,
      permissions: permissionsList,
      permissionsMap: permissions,
      storeName: staffMember.store?.storeName || null,
    };
  } catch (err) {
    return null;
  }
};

const signToken = (userId, staffDetails = null, expiresIn = "1d") => {
  const payload = {
    userId: userId.toString(),
    id: userId.toString(),
  };
  if (staffDetails) {
    payload.isStaff = true;
    payload.isVendorStaff = true;
    payload.storeId = staffDetails.storeId;
    payload.vendor_id = staffDetails.storeId;
    payload.staffRole = staffDetails.staffRole;
    payload.permissions = staffDetails.permissions;
    payload.permissionsMap = staffDetails.permissionsMap;
  }
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
};

const buildUserResponse = (u, staffDetails = null) => ({
  _id: u._id,
  Fullname: u.Fullname,
  email: u.email || null,
  role: u.role,
  isSellerEnabled: Boolean(u.isSellerEnabled),
  phone: u.phone || null,
  gender: u.gender || null,
  companyName: u.companyName || null,
  businessName: u.businessName || u.companyName || null,
  description: u.description || "",
  logoUrl: u.logoUrl || null,
  avatarUrl: u.avatarUrl || null,
  category: u.category || "",
  location: u.location || null,
  isOnboarded: u.isOnboarded,
  verificationStatus: u.verificationStatus,
  lastPasswordChangeAt: u.lastPasswordChangeAt,
  isGuest: Boolean(u.isGuest),
  isStaff: Boolean(staffDetails),
  isVendorStaff: Boolean(staffDetails),
  storeId: staffDetails ? staffDetails.storeId : null,
  store_id: staffDetails ? staffDetails.storeId : null,
  staffRole: staffDetails ? staffDetails.staffRole : null,
  staff_role: staffDetails ? staffDetails.staffRole : null,
  permissions: staffDetails ? staffDetails.permissions : [],
  permissionsMap: staffDetails ? staffDetails.permissionsMap : {},
  staffStoreName: staffDetails ? staffDetails.storeName : null,
  // Profile & account settings
  avatarUrl: u.avatarUrl || "",
  preferences: normalizePreferences(u.preferences),
  email_verified: Boolean(u.email_verified),
  hasPassword: Boolean(u.password),
  googleLinked: Boolean(u.googleId),
  createdAt: u.createdAt,
});

const DEFAULT_PREFERENCES = {
  notifications: { orders: true, payouts: true, messages: true, marketing: false, email: true, sms: true },
  language: "en",
  theme: "system",
};
function normalizePreferences(p) {
  const src = p && typeof p === "object" ? p : {};
  const n = src.notifications && typeof src.notifications === "object" ? src.notifications : {};
  return {
    notifications: Object.fromEntries(Object.entries(DEFAULT_PREFERENCES.notifications).map(([k, d]) => [k, typeof n[k] === "boolean" ? n[k] : d])),
    language: typeof src.language === "string" && /^[a-z]{2}(-[A-Z]{2})?$/.test(src.language) ? src.language : DEFAULT_PREFERENCES.language,
    theme: ["light", "dark", "system"].includes(src.theme) ? src.theme : DEFAULT_PREFERENCES.theme,
  };
}
exports.buildUserResponse = buildUserResponse;
exports.getStaffDetailsForUser = getStaffDetailsForUser;

// The signed-in account (the staff member's own account for staff logins).
const selfOf = (req) => req.staffUser || req.user;

// ─── ME / PROFILE ────────────────────────────────────────────────────────────
exports.getMe = async (req, res) => {
  try {
    const me = await User.findById(selfOf(req)._id);
    if (!me) return res.status(404).json({ message: "Account not found." });
    const staffDetails = await getStaffDetailsForUser(me._id);
    return res.status(200).json({ user: buildUserResponse(me, staffDetails) });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

// @route PATCH /api/auth/profile (portal account settings; PATCH /me is the buyer profile)  { Fullname, gender, phone, email, companyName, preferences, currentPassword }
// Changing the email or phone (both sign-in identifiers) needs the current password.
exports.updateAccount = async (req, res) => {
  try {
    const me = await User.findById(selfOf(req)._id);
    if (!me) return res.status(404).json({ message: "Account not found." });
    const body = req.body || {};

    if (body.Fullname !== undefined || body.fullName !== undefined) {
      const name = String(body.Fullname ?? body.fullName ?? "").trim();
      if (name.length < 2) return res.status(400).json({ message: "Enter your full name." });
      if (name.length > 150) return res.status(400).json({ message: "That name is too long." });
      me.Fullname = name;
    }
    if (body.gender !== undefined) {
      if (!["male", "female", "other"].includes(body.gender)) return res.status(400).json({ message: "Choose a gender option." });
      me.gender = body.gender;
    }
    if (body.companyName !== undefined && me.role === "vendor" && !req.staffMember) {
      const company = String(body.companyName || "").trim();
      if (!company) return res.status(400).json({ message: "Business name can't be empty." });
      me.companyName = company;
    }

    const identityChanges = [];
    if (body.email !== undefined) {
      const email = String(body.email || "").trim().toLowerCase();
      if (email !== (me.email || "")) {
        if (!email && !me.phone) return res.status(400).json({ message: "Keep an email or a phone number to sign in with." });
        if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: "Enter a valid email address." });
        if (email && (await User.exists({ email, _id: { $ne: me._id } }))) return res.status(409).json({ message: "Another account already uses this email." });
        identityChanges.push("email");
        me.email = email || undefined;
        me.email_verified = false;
      }
    }
    if (body.phone !== undefined) {
      const raw = String(body.phone || "").trim();
      const phone = raw ? normalizePhone(raw) : null;
      if (raw && !phone) return res.status(400).json({ message: describePhoneIssue(raw) || "Enter a valid Rwandan phone number." });
      const current = me.phone ? normalizePhone(me.phone) : null;
      if (phone !== current) {
        if (!phone && !me.email) return res.status(400).json({ message: "Keep an email or a phone number to sign in with." });
        if (!phone && !me.googleId && !me.isVendorStaff) return res.status(400).json({ message: "A phone number is required for your account." });
        if (phone && (await User.exists({ phone: { $in: phoneVariants(phone) }, _id: { $ne: me._id } }))) return res.status(409).json({ message: "Another account already uses this phone number." });
        identityChanges.push("phone");
        me.phone = phone ? `0${phone.slice(4)}` : undefined;
      }
    }
    if (identityChanges.length && me.password) {
      if (typeof body.currentPassword !== "string" || !(await bcrypt.compare(body.currentPassword, me.password))) {
        return res.status(400).json({ message: `Enter your current password to change your ${identityChanges.join(" and ")}.`, code: "PASSWORD_REQUIRED" });
      }
    }

    if (body.preferences !== undefined) {
      const current = normalizePreferences(me.preferences);
      const next = body.preferences || {};
      // Invalid values are ignored rather than resetting the saved choice.
      const checked = normalizePreferences(next);
      me.preferences = normalizePreferences({
        ...current,
        ...(next.language !== undefined && checked.language === next.language ? { language: next.language } : {}),
        ...(next.theme !== undefined && checked.theme === next.theme ? { theme: next.theme } : {}),
        notifications: { ...current.notifications, ...Object.fromEntries(Object.entries(next.notifications || {}).filter(([, v]) => typeof v === "boolean")) },
      });
      me.markModified?.("preferences");
    }

    await me.save();
    const staffDetails = await getStaffDetailsForUser(me._id);
    return res.status(200).json({
      message: identityChanges.length ? `Profile saved. Use your new ${identityChanges.join(" or ")} next time you sign in.` : "Profile saved.",
      user: buildUserResponse(me, staffDetails),
    });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ message: "That email or phone is already in use." });
    if (error.name === "ValidationError") return res.status(400).json({ message: Object.values(error.errors || {})[0]?.message || error.message });
    return res.status(500).json({ message: "Unable to save your profile." });
  }
};

// @route DELETE /api/auth/avatar
exports.removeAvatar = async (req, res) => {
  try {
    await User.updateOne({ _id: selfOf(req)._id }, { $set: { avatarUrl: "" } });
    return res.status(200).json({ message: "Photo removed.", avatarUrl: "" });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @route POST /api/auth/logout-all — signs out every device; returns a fresh token for this one.
exports.logoutAll = async (req, res) => {
  try {
    const me = selfOf(req);
    const validAfter = new Date(Math.floor(Date.now() / 1000) * 1000);
    await User.updateOne({ _id: me._id }, { $set: { tokensValidAfter: validAfter } });
    const staffDetails = await getStaffDetailsForUser(me._id);
    return res.status(200).json({ message: "Signed out on all other devices.", token: signToken(me._id, staffDetails) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
const buildAuthenticatedUserResponse = async (user, staffDetails = null) => {
  const details = staffDetails || await getStaffDetailsForUser(user._id);
  const response = buildUserResponse(user, details);
  if (user.role === "vendor" || user.role === "supplier") {
    const Profile = user.role === "vendor" ? Vendor : Supplier;
    let profile = await Profile.findOne({ user: user._id }).lean();

    // Team members inherit the owner's profile: a vendor staff account has no
    // Vendor document of its own, so without this the member would be reported
    // as "not onboarded" and forced through onboarding that already happened.
    if (!profile && user.role === "vendor") {
      const staffMembership = await Staff.findOne({
        $or: [{ user: user._id }, { user_id: user._id }],
        status: "ACTIVE",
      }).lean();
      if (staffMembership) profile = await Vendor.findOne({ user: staffMembership.vendorOwner }).lean();
    }

    if (!profile && user.role === "supplier") {
      const membership = await SupplierTeamMember.findOne({ user: user._id, status: "ACTIVE" }).lean();
      if (membership) profile = await Supplier.findById(membership.supplier).lean();
    }
    const requiredComplete = Boolean(
      profile?.businessName && profile?.email && profile?.phone &&
      profile?.description && profile?.logoUrl && profile?.category && profile?.location,
    );
    response.isOnboarded = requiredComplete;
    response.verificationStatus = profile?.verificationStatus || "UNVERIFIED";
    response.verificationNote = profile?.verificationNote || "";
    response.businessName = profile?.businessName || response.companyName;
    response.logoUrl = profile?.logoUrl || null;
    response.description = profile?.description || "";
    response.category = profile?.category || "";
    response.location = profile?.location || null;
  } else {
    response.isOnboarded = true;
    response.verificationStatus = "VERIFIED";
  }
  const membership = await vendorStaffInvitation.getActiveMembership(user._id);
  if (membership) {
    return {
      ...response,
      vendorStaff: true,
      vendorOwnerId: membership.vendorOwner.toString(),
      staffRole: membership.role,
      vendorPermissions: membership.permissions,
    };
  }

  // Supplier team members have no Vendor/Supplier profile of their own either;
  // expose their team role so the client can hide the sections that role is
  // not allowed to use.
  if (user.role === "supplier") {
    const teamMembership = await SupplierTeamMember.findOne({ user: user._id, status: "ACTIVE" }).lean();
    if (teamMembership) {
      return { ...response, isSupplierStaff: true, supplierTeamRole: teamMembership.role };
    }
  }

  return response;
};

exports.getAuthenticatedUserResponse = buildAuthenticatedUserResponse;

// ─── REGISTER USER ───────────────────────────────────────────────────────────
// Supports two flows:
//   1. Legacy sign-up: Fullname, email, password, gender, phone, role.
//   2. Phone-first sign-up (OTP): full profile + a `verificationToken` issued
//      by POST /api/auth/verify-otp (purpose "registration"). email optional.
exports.registerUser = async (req, res) => {
  try {
    const {
      Fullname,
      email,
      password,
      gender,
      phone,
      role,
      companyName,
      verificationToken,
      staffInviteToken,
    } = req.body;
    // Only these roles can be chosen at sign-up. Privileged roles
    // (super_admin, developer, delivery) are assigned by an administrator.
    const SELF_SERVICE_ROLES = ["buyer", "vendor", "supplier", "affiliate"];
    const accountRole = staffInviteToken ? "buyer" : (role || "buyer");
    if (!SELF_SERVICE_ROLES.includes(accountRole)) {
      return res.status(400).json({ message: "Please choose a valid account type." });
    }

    if (!Fullname || typeof Fullname !== "string" || !Fullname.trim() || !password) {
      return res.status(400).json({ message: "Your name and a password are required" });
    }
    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ message: "Password must be at least 8 characters long" });
    }
    if (gender && !["male", "female", "other"].includes(gender)) {
      return res.status(400).json({ message: "Please choose a valid gender or leave it empty" });
    }
    if (email && (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))) {
      return res.status(400).json({ message: "Please enter a valid email address or leave it empty" });
    }

    if (!phone && !verificationToken) {
      return res.status(400).json({ message: "Phone number is required" });
    }

    if (accountRole === "vendor" && !companyName) {
      return res.status(400).json({ message: "Company name is required" });
    }

    // Validate that the phone was actually verified via OTP when supplied.
    let verifiedPhone = null;
    if (verificationToken) {
      let decoded;
      try {
        decoded = jwt.verify(verificationToken, process.env.JWT_SECRET);
      } catch {
        return res.status(400).json({
          message: "Invalid or expired phone verification. Please re-verify.",
        });
      }
      if (
        decoded.purpose !== "registration" ||
        !normalizePhone(decoded.phone)
      ) {
        return res.status(400).json({
          message: "Invalid phone verification token",
        });
      }
      verifiedPhone = normalizePhone(decoded.phone);

      // If a phone was also sent in the body, it must match the verified phone.
      if (phone) {
        const bodyPhone = normalizePhone(phone);
        if (bodyPhone !== verifiedPhone) {
          return res.status(400).json({
            message: "Phone number does not match the verified phone number.",
          });
        }
      }
    } else {
      verifiedPhone = normalizePhone(phone);
    }

    if (!verifiedPhone) {
      return res.status(400).json({
        message:
          describePhoneIssue(phone) ||
          "A valid Rwandan phone number is required (e.g. 0788123456 or +250781234567)",
      });
    }

    const normalizedEmail = email ? email.trim().toLowerCase() : undefined;
    if (staffInviteToken) {
      if (!normalizedEmail) {
        return res.status(400).json({
          message: "Use the email address that received the invitation.",
        });
      }
      const invitation = await vendorStaffInvitation.findPendingInvitation(
        staffInviteToken,
        normalizedEmail,
      );
      if (!invitation) {
        return res.status(400).json({
          message: "This vendor team invitation is invalid or has expired.",
        });
      }
    }

    // Duplicate checks are done per field on purpose: folding "no email given"
    // into the $or used to cast to an empty clause ({}), which matches ANY
    // user, so a phone-only sign-up was always told an account already exists.
    if (normalizedEmail) {
      const emailTaken = await User.findOne({ email: normalizedEmail });
      if (emailTaken) {
        return res.status(400).json({
          message:
            "An account with this email already exists. Log in with it instead, or use a different email.",
        });
      }
    }

    const phoneTaken = await User.findOne({
      phone: { $in: phoneVariants(verifiedPhone) },
    });
    if (phoneTaken) {
      return res.status(400).json({
        message: phoneTaken.isGuest
          ? "You've ordered with this number as a guest. Use \"Forgot password\" with this number to set a password for that account."
          : "An account with this phone number already exists. Log in with it instead, or use a different number.",
      });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create a new user
    const newUser = new User({
      Fullname: Fullname.trim().slice(0, 120),
      email: normalizedEmail,
      password: hashedPassword,
      gender: gender || undefined,
      phone: verifiedPhone,
      role: accountRole,
      companyName: ["vendor", "supplier"].includes(accountRole) && companyName ? companyName.trim() : undefined,
    });

    // Save the user to the database
    await newUser.save();

    if (staffInviteToken) {
      const membership = await vendorStaffInvitation.acceptInvitation(
        staffInviteToken,
        newUser,
      );
      if (!membership) {
        await newUser.deleteOne();
        return res.status(400).json({
          message: "This vendor team invitation has already been used or expired.",
        });
      }
    }

    // Generate JWT token so frontend can immediately log in after registration
    const staffDetails = await getStaffDetailsForUser(newUser._id);
    const token = signToken(newUser._id, staffDetails);

    return res.status(201).json({
      message: "User registered successfully",
      user: await buildAuthenticatedUserResponse(newUser, staffDetails),
      token,
    });
  } catch (error) {
    // Duplicate key: the unique email/phone indexes. Surface which field
    // collided instead of leaking a generic 500.
    if (error && (error.code === 11000 || error.code === 11001)) {
      const key = Object.keys(error.keyPattern || error.keyValue || {})[0];
      if (key === "email") {
        return res.status(400).json({
          message:
            "An account with this email already exists. Log in with it instead, or use a different email.",
        });
      }
      if (key === "phone") {
        return res.status(400).json({
          message:
            "An account with this phone number already exists. Log in with it instead, or use a different number.",
        });
      }
      return res.status(400).json({
        message: "An account with those details already exists.",
      });
    }
    console.error("Error registering user:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// ─── LOGIN USER ──────────────────────────────────────────────────────────────
exports.loginUser = async (req, res) => {
  try {
    const { email, phone, password, staffInviteToken } = req.body;

    if ((!email && !phone) || !password) {
      return res
        .status(400)
        .json({ message: "Email or phone and password are required" });
    }

    const normalizedEmail = email ? email.trim().toLowerCase() : null;

    // A malformed / incomplete phone number used to fall through to the lookup,
    // find nothing, and come back as "Invalid email/phone or password" — which
    // reads as a wrong password. Report what is actually wrong with the number.
    let phoneVariantsList = [];
    if (phone) {
      phoneVariantsList = phoneVariants(phone);
      if (!phoneVariantsList.length) {
        return res.status(400).json({
          message: describePhoneIssue(phone),
        });
      }
    }

    const user = await User.findOne(
      normalizedEmail && phoneVariantsList.length
        ? { $or: [{ email: normalizedEmail }, { phone: { $in: phoneVariantsList } }] }
        : normalizedEmail
        ? { email: normalizedEmail }
        : { phone: { $in: phoneVariantsList } }
    ).select("+isVendorStaff");

    if (!user) {
      return res.status(400).json({ message: "Invalid email/phone or password" });
    }
    // Check if user is a Google-only account without password
    if (!user.password && user.googleId) {
      return res.status(400).json({
        message:
          "This account was created using Google Sign-In. Please log in with Google.",
      });
    }

    // Compare the provided password with the hashed password in the database
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ message: "Invalid email/phone or password" });
    }
    // Checked after the password, so a wrong guess can't learn that the account exists.
    if (user.status !== "ACTIVE") {
      return res.status(403).json({
        message: user.isVendorStaff
          ? "This account is suspended. Contact the store owner or MVEC support."
          : "This account is blocked or suspended. Contact MVEC support.",
        code: "ACCOUNT_BLOCKED",
      });
    }

    if (staffInviteToken) {
      const membership = await vendorStaffInvitation.acceptInvitation(
        staffInviteToken,
        user,
      );
      if (!membership) {
        return res.status(400).json({
          message: "This vendor team invitation is invalid, expired, or already used.",
        });
      }
    }
    const staffDetails = await getStaffDetailsForUser(user._id);

    // Generate a JWT token for the authenticated user
    const token = signToken(user._id, staffDetails);

    // Return response excluding sensitive password hash
    const userResponse = await buildAuthenticatedUserResponse(user, staffDetails);

    return res.status(200).json({
      message: "Login successful",
      user: userResponse,
      token,
    });
  } catch (error) {
    console.error("Error logging in user:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// @desc    Update the signed-in user's own profile
// @route   PATCH /api/auth/me
// @access  Private
// Phone number and role are deliberately not editable here: the phone is the
// login identity (changing it needs OTP verification) and roles are assigned.
exports.updateProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: "Account not found." });

    const { Fullname, fullName, email, gender } = req.body;
    const name = typeof (Fullname ?? fullName) === "string" ? (Fullname ?? fullName).trim() : undefined;
    if (name !== undefined) {
      if (name.length < 2 || name.length > 120) {
        return res.status(400).json({ message: "Please enter your full name (2 to 120 characters)." });
      }
      user.Fullname = name;
    }

    if (email !== undefined) {
      const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
      if (normalizedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({ message: "Please enter a valid email address or leave it empty." });
      }
      if (normalizedEmail && normalizedEmail !== user.email) {
        const taken = await User.exists({ email: normalizedEmail, _id: { $ne: user._id } });
        if (taken) return res.status(400).json({ message: "Another account already uses this email." });
      }
      if (!normalizedEmail && !user.phone) {
        return res.status(400).json({ message: "Your account needs an email or a phone number." });
      }
      user.email = normalizedEmail || undefined;
    }

    if (gender !== undefined) {
      if (gender && !["male", "female", "other"].includes(gender)) {
        return res.status(400).json({ message: "Please choose a valid gender or leave it empty." });
      }
      user.gender = gender || undefined;
    }

    await user.save();
    const response = await buildAuthenticatedUserResponse(user);
    return res.status(200).json({ message: "Profile updated.", user: response });
  } catch (error) {
    console.error("Error updating profile:", error);
    return res.status(500).json({ message: "Unable to update your profile." });
  }
};

exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(selfOf(req)._id);
    if (!user) return res.status(404).json({ message: "Account not found." });
    // Google-only accounts have no password yet and may set one.
    const settingFirst = !user.password;
    if (typeof newPassword !== "string" || newPassword.length < 8 || (!settingFirst && typeof currentPassword !== "string")) {
      return res.status(400).json({ message: settingFirst ? "Choose a password of at least 8 characters." : "Enter your current password and a new password of at least 8 characters." });
    }
    if (!settingFirst && !(await bcrypt.compare(currentPassword, user.password))) {
      return res.status(400).json({ message: "Current password is incorrect." });
    }
    if (!settingFirst && (await bcrypt.compare(newPassword, user.password))) {
      return res.status(400).json({ message: "Choose a password different from your current one." });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    user.lastPasswordChangeAt = new Date();
    // Other devices are signed out; this one gets a fresh token.
    user.tokensValidAfter = new Date(Math.floor(Date.now() / 1000) * 1000);
    await user.save();
    const staffDetails = await getStaffDetailsForUser(user._id);
    return res.status(200).json({
      message: settingFirst ? "Password set. You can now also sign in with your email or phone." : "Password updated. Other devices were signed out.",
      lastPasswordChangeAt: user.lastPasswordChangeAt,
      token: signToken(user._id, staffDetails),
    });
  } catch (error) {
    return res.status(500).json({ message: "Unable to update password.", error: error.message });
  }
};

// ─── GOOGLE SIGN-IN ──────────────────────────────────────────────────────────
// Verifies a Google ID token (produced on the frontend by the GSI library or
// Google Identity Services), then creates a new account, links an existing
// email/password account, or signs the user straight in — returning a JWT.
exports.googleLogin = async (req, res) => {
  try {
    const idToken = req.body.idToken || req.body.token;
    const requestedRole = req.body.role;

    if (!idToken || typeof idToken !== "string") {
      return res.status(400).json({ message: "Google ID token is required" });
    }

    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(500).json({
        message:
          "Google Sign-In is not configured. Please set GOOGLE_CLIENT_ID in the backend environment.",
      });
    }

    // Verify the ID token's signature, audience and expiry with Google
    const client = getGoogleClient();
    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const { email, name, sub: googleId, email_verified } = payload;

    // Google guarantees verified addresses from the hosted domain UI, but we
    // still fail closed when the profile is missing an email.
    if (!email) {
      return res.status(400).json({
        message: "Your Google account has no email address we can use.",
      });
    }

    const normalizedEmail = email.toLowerCase();

    // Case 1: existing user with the same Google ID → sign straight in.
    let user = await User.findOne({ googleId });

    // Case 2: existing account with this email (password-based) → link Google ID.
    if (!user) {
      const byEmail = await User.findOne({ email: normalizedEmail });
      if (byEmail) {
        byEmail.googleId = googleId;
        await byEmail.save();
        user = byEmail;
      }
    }

    // Case 3: brand new Google user → create the account. Credentials that are
    // required on the normal sign-up form (password, gender, phone) are not
    // needed for a Google-authenticated profile.
    if (!user) {
      const allowedRoles = ["buyer", "vendor", "supplier", "affiliate"];
      const role = allowedRoles.includes(requestedRole) ? requestedRole : "buyer";

      user = new User({
        Fullname: name || "Google User",
        email: normalizedEmail,
        googleId,
        role,
        email_verified: Boolean(email_verified),
      });
      await user.save();
    }

    const staffDetails = await getStaffDetailsForUser(user._id);
    const token = signToken(user._id, staffDetails);

    return res.status(200).json({
      message: "Google sign-in successful",
      user: await buildAuthenticatedUserResponse(user, staffDetails),
      token,
    });
  } catch (error) {
    if (error.message && error.message.includes("GOOGLE_CLIENT_ID")) {
      return res.status(500).json({ message: error.message });
    }
    // Google library failures on bad/expired/mismatched tokens and audience.
    if (
      error.message &&
      /invalid token|wrong number of segments|audience|no pem|key id|token used too late|could not retrieve/i.test(
        error.message,
      )
    ) {
      return res.status(401).json({ message: "Invalid Google ID token" });
    }
    console.error("Error logging in with Google:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// ─── HELPER: NODEMAILER TRANSPORTER ──────────────────────────────────────────
const getTransporter = () => {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;

  if (!user || !pass) {
    throw new Error(
      "Email credentials are not configured. Please set EMAIL_USER and EMAIL_PASS environment variables."
    );
  }

  // If EMAIL_HOST is provided, use custom SMTP options; otherwise fallback to Gmail service
  if (process.env.EMAIL_HOST) {
    return nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: Number(process.env.EMAIL_PORT) || 587,
      secure: process.env.EMAIL_SECURE === "true" || process.env.EMAIL_PORT === "465",
      auth: { user, pass },
    });
  }

  return nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || "Gmail",
    auth: { user, pass },
  });
};

const sendResetEmail = async (toEmail, resetUrl) => {
  const transporter = getTransporter();
  const fromAddress = process.env.EMAIL_FROM || process.env.EMAIL_USER;

  await transporter.sendMail({
    from: `"MVEC Support" <${fromAddress}>`,
    to: toEmail,
    subject: "Password Reset Request",
    text: `You requested a password reset for your MVEC account.\n\nPlease click the following link to reset your password (valid for 15 minutes):\n${resetUrl}\n\nIf you did not request this, please ignore this email.`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          .container { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px; }
          .header { text-align: center; border-bottom: 1px solid #eee; padding-bottom: 15px; margin-bottom: 20px; }
          .btn { background-color: #4CAF50; color: #ffffff !important; padding: 12px 24px; text-decoration: none; display: inline-block; border-radius: 5px; font-weight: bold; margin: 15px 0; }
          .footer { font-size: 12px; color: #888; margin-top: 25px; border-top: 1px solid #eee; padding-top: 15px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>Password Reset Request</h2>
          </div>
          <p>Hello,</p>
          <p>You requested a password reset for your MVEC account. Click the button below to set a new password:</p>
          <p style="text-align: center;">
            <a href="${resetUrl}" class="btn" style="color: #ffffff;">Reset Password</a>
          </p>
          <p>Or copy and paste this link into your browser:</p>
          <p><a href="${resetUrl}">${resetUrl}</a></p>
          <p><strong>Note:</strong> This link is valid for 15 minutes only. If you did not request this, please ignore this email.</p>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} MVEC. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `,
  });
};

// Export assisting functions for unit tests
exports.getTransporter = getTransporter;
exports.sendResetEmail = sendResetEmail;

// ─── 1. FORGOT PASSWORD CONTROLLER ───────────────────────────────────────────
// ─── PASSWORD RESET (code by email or SMS) ──────────────────────────────────
// 1. POST /api/auth/forgot-password   { email } or { phone }  → sends a 6-digit code
// 2. POST /api/auth/verify-reset-otp  { email|phone, code }   → returns a short-lived resetToken
// 3. POST /api/auth/reset-password    { resetToken, newPassword }
// Responses never reveal whether an account exists.
const RESET_CODE_TTL_MS = 15 * 60 * 1000;
const RESET_TOKEN_TTL_MS = 10 * 60 * 1000;
const RESET_MAX_ATTEMPTS = 5;
const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const messaging = require("../services/messaging.service");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const maskEmail = (email) => {
  const [name, domain] = String(email).split("@");
  return `${name.slice(0, 2)}•••@${domain}`;
};
const maskPhone = (phone) => {
  const digits = String(phone).replace(/\D/g, "");
  return `•••${digits.slice(-3)}`;
};

// Sends a one-time code by every real channel available: a text message when
// an SMS gateway is set up, and an email when there is an address. Codes are
// never returned to the screen. Only when neither works on a development
// server is the text written to the server log instead.
// Returns { sms, email, log, message } or null when nothing could be sent.
async function deliverCode({ phone, email, sms, subject, text }) {
  const sent = { sms: false, email: null, log: false };
  const provider = messaging.smsProvider();
  if (phone && provider && provider !== "log") {
    try {
      await messaging.sendSms(phone, sms);
      sent.sms = true;
    } catch (err) {
      console.error("Code SMS failed:", err.message);
    }
  }
  if (email && messaging.emailConfigured()) {
    try {
      await messaging.sendEmail({ to: email, subject, text });
      sent.email = maskEmail(email);
    } catch (err) {
      console.error("Code email failed:", err.message);
    }
  }
  if (!sent.sms && !sent.email && phone && provider === "log") {
    await messaging.sendSms(phone, sms);
    sent.log = true;
  }
  if (sent.sms && sent.email) sent.message = `We sent a 6-digit code to your phone (${maskPhone(phone)}) and to ${sent.email}.`;
  else if (sent.email) sent.message = `We emailed a 6-digit code to ${sent.email}. Check your inbox and spam folder.`;
  else if (sent.sms) sent.message = `We texted a 6-digit code to ${maskPhone(phone)}.`;
  else if (sent.log) sent.message = "Text messages are not set up on this server yet, so the code was written to the server log.";
  else return null;
  return sent;
}

async function findResetUser({ email, phone }) {
  if (email && typeof email === "string" && email.trim()) {
    return User.findOne({ email: email.trim().toLowerCase() })
      .select("+resetPasswordCode +resetPasswordCodeExpires +resetPasswordAttempts");
  }
  const variants = phoneVariants(phone);
  if (!variants.length) return null;
  return User.findOne({ phone: { $in: variants } })
    .select("+resetPasswordCode +resetPasswordCodeExpires +resetPasswordAttempts");
}

exports.forgotPassword = async (req, res) => {
  try {
    const { email, phone } = req.body;
    const byEmail = typeof email === "string" && email.trim();
    if (!byEmail && !normalizePhone(phone)) {
      return res.status(400).json({ message: "Enter the email or phone number on your account." });
    }

    const genericResponse = {
      message: byEmail
        ? "If an account uses that email, we sent it a 6-digit code."
        : "If an account uses that phone number, we sent a 6-digit code by text message or to the email on the account.",
    };

    const user = await findResetUser({ email, phone });
    if (!user) return res.status(200).json(genericResponse);
    if (!user.password && user.googleId) {
      return res.status(400).json({ message: "This account signs in with Google. Use Continue with Google instead." });
    }

    const code = String(crypto.randomInt(100000, 1000000));
    user.resetPasswordCode = sha256(code);
    user.resetPasswordCodeExpires = new Date(Date.now() + RESET_CODE_TTL_MS);
    user.resetPasswordAttempts = 0;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save({ validateBeforeSave: false });

    const emailText = `Your password reset code is ${code}.\nIt expires in 15 minutes.\nIf you did not ask to reset your password, you can ignore this email.`;
    let delivered = false;
    try {
      if (byEmail) {
        await messaging.sendEmail({ to: user.email, subject: "Your MVEC password reset code", text: emailText });
        delivered = true;
      } else {
        // By phone: a text message when SMS is set up, and the account's own
        // email too, so the code still arrives without an SMS gateway.
        delivered = Boolean(await deliverCode({
          phone: user.phone,
          email: user.email,
          sms: `Your MVEC password reset code is ${code}. It expires in 15 minutes.`,
          subject: "Your MVEC password reset code",
          text: emailText,
        }));
      }
    } catch (sendError) {
      console.error("Password reset delivery failed:", sendError.message);
    }
    if (!delivered) {
      user.resetPasswordCode = undefined;
      user.resetPasswordCodeExpires = undefined;
      await user.save({ validateBeforeSave: false });
      return byEmail
        ? res.status(502).json({ message: "We could not send the code. Please try again in a few minutes." })
        : res.status(503).json({ message: "Text messages are not available right now. Use your email address instead." });
    }

    return res.status(200).json(genericResponse);
  } catch (error) {
    console.error("Forgot Password Error:", error);
    return res.status(500).json({ message: "Failed to process request" });
  }
};

exports.verifyResetOtp = async (req, res) => {
  try {
    const { email, phone, code } = req.body;
    const invalid = { message: "That code is incorrect or has expired. Request a new one." };
    if (!/^\d{6}$/.test(String(code || ""))) return res.status(400).json(invalid);

    const user = await findResetUser({ email, phone });
    if (!user || !user.resetPasswordCode || !user.resetPasswordCodeExpires || user.resetPasswordCodeExpires < new Date()) {
      return res.status(400).json(invalid);
    }
    if ((user.resetPasswordAttempts || 0) >= RESET_MAX_ATTEMPTS) {
      return res.status(429).json({ message: "Too many wrong codes. Request a new code." });
    }

    const matches = crypto.timingSafeEqual(Buffer.from(sha256(code)), Buffer.from(user.resetPasswordCode));
    if (!matches) {
      user.resetPasswordAttempts = (user.resetPasswordAttempts || 0) + 1;
      await user.save({ validateBeforeSave: false });
      return res.status(400).json(invalid);
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    user.resetPasswordToken = sha256(resetToken);
    user.resetPasswordExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    user.resetPasswordCode = undefined;
    user.resetPasswordCodeExpires = undefined;
    user.resetPasswordAttempts = 0;
    await user.save({ validateBeforeSave: false });

    return res.status(200).json({ message: "Code verified.", resetToken });
  } catch (error) {
    console.error("Verify reset code error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// Accepts the token in the body (code flow) or in the URL (older email links).
exports.resetPassword = async (req, res) => {
  try {
    const token = req.params.token || req.body.resetToken;
    const newPassword = req.body.newPassword || req.body.password;

    if (!token || typeof token !== "string" || !token.trim()) {
      return res.status(400).json({ message: "Reset token is required" });
    }
    if (!newPassword || typeof newPassword !== "string" || newPassword.length < 8) {
      return res.status(400).json({ message: "Your new password must be at least 8 characters long." });
    }

    const user = await User.findOne({
      resetPasswordToken: sha256(token.trim()),
      resetPasswordExpires: { $gt: Date.now() },
    });
    if (!user) {
      return res.status(400).json({ message: "This reset session has expired. Request a new code." });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    user.isGuest = false; // a guest who sets a password now has a full account
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    // Signs out every existing session (see protect middleware).
    user.lastPasswordChangeAt = new Date();
    await user.save();

    return res.status(200).json({ message: "Password reset. You can now log in with your new password." });
  } catch (error) {
    console.error("Reset Password Error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// ─── 3. USER ADDRESSES ───────────────────────────────────────────────────────
// @desc    Add a new address for logged-in user
// @route   POST /api/auth/addresses
// @access  Private
exports.addAddress = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id || req.user.userId;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const {
      type,
      country,
      provinceState,
      cityDistrict,
      sector,
      street,
      building,
      apartment,
      postalCode,
      phone,
      deliveryInstructions,
      isDefaultShipping,
      isDefaultBilling,
    } = req.body;

    if (user.addresses.length >= 10) {
      return res.status(400).json({ message: "You can save up to 10 addresses. Remove one first." });
    }
    const addressPhone = normalizePhone(phone);
    if (!addressPhone) {
      return res.status(400).json({ message: "Please enter a valid Rwandan phone number for this address." });
    }

    // Unset current default flags if this address is being set as default
    if (isDefaultShipping) {
      user.addresses.forEach((addr) => (addr.isDefaultShipping = false));
    }
    if (isDefaultBilling) {
      user.addresses.forEach((addr) => (addr.isDefaultBilling = false));
    }

    // First address added automatically becomes default
    const isFirstAddress = user.addresses.length === 0;

    user.addresses.push({
      type,
      country,
      provinceState,
      cityDistrict,
      sector,
      street,
      building,
      apartment,
      postalCode,
      phone: addressPhone,
      deliveryInstructions,
      isDefaultShipping: isFirstAddress ? true : Boolean(isDefaultShipping),
      isDefaultBilling: isFirstAddress ? true : Boolean(isDefaultBilling),
    });

    await user.save();
    return res.status(201).json({
      message: "Address added successfully",
      addresses: user.addresses,
    });
  } catch (error) {
    console.error("Error adding address:", error);
    return res.status(400).json({ message: error.message });
  }
};

// @desc    Get all addresses for logged-in user
// @route   GET /api/auth/addresses
// @access  Private
exports.getAddresses = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id || req.user.userId;
    const user = await User.findById(userId).select("addresses");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({ addresses: user.addresses });
  } catch (error) {
    console.error("Error fetching addresses:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// @desc    Update an existing address
// @route   PUT /api/auth/addresses/:addressId
// @access  Private
exports.updateAddress = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id || req.user.userId;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const address = user.addresses.id(req.params.addressId);
    if (!address) {
      return res.status(404).json({ message: "Address not found" });
    }

    const { isDefaultShipping, isDefaultBilling, _id, ...updateFields } = req.body;
    if (updateFields.phone !== undefined) {
      const addressPhone = normalizePhone(updateFields.phone);
      if (!addressPhone) {
        return res.status(400).json({ message: "Please enter a valid Rwandan phone number for this address." });
      }
      updateFields.phone = addressPhone;
    }

    // Handle default flag switches across other stored addresses
    if (isDefaultShipping) {
      user.addresses.forEach((addr) => (addr.isDefaultShipping = false));
    }
    if (isDefaultBilling) {
      user.addresses.forEach((addr) => (addr.isDefaultBilling = false));
    }

    Object.assign(address, updateFields);
    if (typeof isDefaultShipping !== "undefined") {
      address.isDefaultShipping = Boolean(isDefaultShipping);
    }
    if (typeof isDefaultBilling !== "undefined") {
      address.isDefaultBilling = Boolean(isDefaultBilling);
    }

    await user.save();
    return res.status(200).json({
      message: "Address updated successfully",
      addresses: user.addresses,
    });
  } catch (error) {
    console.error("Error updating address:", error);
    return res.status(400).json({ message: error.message });
  }
};

// @desc    Delete an address
// @route   DELETE /api/auth/addresses/:addressId
// @access  Private
exports.deleteAddress = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id || req.user.userId;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const address = user.addresses.id(req.params.addressId);
    if (!address) {
      return res.status(404).json({ message: "Address not found" });
    }

    const wasDefaultShipping = address.isDefaultShipping;
    const wasDefaultBilling = address.isDefaultBilling;

    // Remove the address subdocument
    address.deleteOne();

    // Reassign defaults if a default address was deleted
    if (user.addresses.length > 0) {
      if (wasDefaultShipping && !user.addresses.some((a) => a.isDefaultShipping)) {
        user.addresses[0].isDefaultShipping = true;
      }
      if (wasDefaultBilling && !user.addresses.some((a) => a.isDefaultBilling)) {
        user.addresses[0].isDefaultBilling = true;
      }
    }

    await user.save();
    return res.status(200).json({
      message: "Address deleted successfully",
      addresses: user.addresses,
    });
  } catch (error) {
    console.error("Error deleting address:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// ─── OTP: SEND VERIFICATION CODE ────────────────────────────────────────────
// @desc    Send a one-time verification code to a phone number via SMS
// @route   POST /api/auth/send-otp
// @access  Public
// @body    { phone: "0788123456", purpose: "registration" | "login", email? }
exports.sendOtp = async (req, res) => {
  try {
    const { phone, purpose, email } = req.body;

    const validPurposes = ["registration", "login"];
    if (!validPurposes.includes(purpose)) {
      return res.status(400).json({
        message: `purpose must be one of: ${validPurposes.join(", ")}`,
      });
    }

    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      return res.status(400).json({
        message: `A valid Rwandan phone number is required (e.g. 0788123456 or +250781234567). ${describePhoneIssue(phone) || ""}`.trim(),
      });
    }

    const otpTtlSeconds = Number(process.env.OTP_EXPIRY_SECONDS || 300);
    const cooldownSeconds = Number(process.env.OTP_COOLDOWN_SECONDS || 60);

    // 1. Rate-limit: block re-sends for the same phone+purpose within the cooldown.
    const recent = await Otp.findOne({
      phone: normalizedPhone,
      purpose,
      lastSentAt: { $gt: new Date(Date.now() - cooldownSeconds * 1000) },
    });
    if (recent) {
      return res.status(429).json({
        message: `Please wait ${cooldownSeconds}s before requesting a new code.`,
      });
    }

    // 2. Generate and hash the code.
    const code = generateOtpCode(6);
    const codeHash = crypto
      .createHash("sha256")
      .update(code)
      .digest("hex");

    // 3. Invalidate any previous unconsumed codes for this phone+purpose.
    await Otp.updateMany(
      { phone: normalizedPhone, purpose, consumed: false },
      { $set: { consumed: true } },
    );

    // 4. Persist a fresh record.
    await Otp.create({
      phone: normalizedPhone,
      codeHash,
      purpose,
      email: email ? email.trim().toLowerCase() : undefined,
      expiresAt: new Date(Date.now() + otpTtlSeconds * 1000),
      attempts: 0,
      lastSentAt: new Date(),
      consumed: false,
    });

    // 5. Deliver the code by text message and email. An existing account's
    //    code only ever goes to that account's own email, never to an address
    //    typed into the form, so knowing someone's phone number is not enough
    //    to sign in as them.
    const account = await User.findOne({ phone: { $in: phoneVariants(normalizedPhone) } });
    const typedEmail = typeof email === "string" && EMAIL_RE.test(email.trim()) ? email.trim().toLowerCase() : null;
    let sent = null;
    try {
      sent = await deliverCode({
        phone: normalizedPhone,
        email: account ? account.email : typedEmail,
        sms: `Your MVEC verification code is ${code}. It expires in ${Math.round(otpTtlSeconds / 60)} minutes. Never share it.`,
        subject: "Your MVEC verification code",
        text: `Your MVEC verification code is ${code}.\nIt expires in ${Math.round(otpTtlSeconds / 60)} minutes.\nNever share this code with anyone. If you did not ask for it, you can ignore this email.`,
      });
    } catch (sendError) {
      console.error("OTP delivery failed:", sendError.message);
    }
    if (!sent) {
      await Otp.updateMany({ phone: normalizedPhone, purpose, consumed: false }, { $set: { consumed: true } });
      return res.status(503).json({
        message: account && !account.email
          ? "We could not send a text message right now. Try again in a few minutes."
          : "Text messages are not available right now. Add your email address and we will send the code there.",
        code: "CODE_NOT_SENT",
      });
    }

    return res.status(200).json({ message: sent.message, sentTo: { sms: sent.sms, email: sent.email } });
  } catch (error) {
    console.error("Error sending OTP:", error);
    return res.status(500).json({ message: "Failed to send verification code" });
  }
};

// ─── OTP: VERIFY & CONSUME CODE ─────────────────────────────────────────────
// @desc    Validate the phone OTP code for passwordless login / registration
// @route   POST /api/auth/verify-otp
// @access  Public
// @body    { phone, code, purpose, role? }
//          - purpose "login"         → signs the user in (passwordless) with a JWT
//          - purpose "registration"  → confirms ownership of the phone; returns a
//                                      short-lived verificationToken that the
//                                      sign-up flow presents along with the rest
//                                      of the profile to /api/auth/register.
// Checks a one-time code for phone+purpose and uses it up. Returns null when
// the code is right, otherwise { status, message }. Wrong guesses count
// against the code and lock it after OTP_MAX_ATTEMPTS.
async function consumeOtp(normalizedPhone, code, purpose) {
  const codeHash = crypto.createHash("sha256").update(String(code).trim()).digest("hex");
  const otp = await Otp.findOne({
    phone: normalizedPhone,
    purpose,
    consumed: false,
    expiresAt: { $gt: Date.now() },
  }).sort({ createdAt: -1 });
  if (!otp) return { status: 400, message: "Invalid or expired verification code" };

  const maxAttempts = Number(process.env.OTP_MAX_ATTEMPTS || 5);
  if (otp.codeHash !== codeHash) {
    otp.attempts += 1;
    const exhausted = otp.attempts >= maxAttempts;
    if (exhausted) otp.consumed = true;
    await otp.save();
    return exhausted
      ? { status: 429, message: "Too many failed attempts. Please request a new code." }
      : { status: 400, message: "Invalid or expired verification code" };
  }
  otp.consumed = true; // single-use
  await otp.save();
  return null;
}

exports.verifyOtp = async (req, res) => {
  try {
    const { phone, code, purpose, role } = req.body;

    const validPurposes = ["registration", "login"];
    if (!validPurposes.includes(purpose)) {
      return res.status(400).json({
        message: `purpose must be one of: ${validPurposes.join(", ")}`,
      });
    }

    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      return res.status(400).json({
        message: `A valid Rwandan phone number is required (e.g. 0788123456 or +250781234567). ${describePhoneIssue(phone) || ""}`.trim(),
      });
    }

    if (!code || typeof code !== "string" || !/^\d{6}$/.test(code.trim())) {
      return res
        .status(400)
        .json({ message: "A 6-digit verification code is required" });
    }

    const otpFailure = await consumeOtp(normalizedPhone, code, purpose);
    if (otpFailure) return res.status(otpFailure.status).json({ message: otpFailure.message });

    // ── PURPOSE: PASSWORDLESS LOGIN ─────────────────────────────────────────
    if (purpose === "login") {
      const user = await User.findOne({
        phone: { $in: phoneVariants(normalizedPhone) },
      });

      if (!user) {
        return res.status(404).json({
          message:
            "No account is linked to this phone number. Please register first.",
        });
      }

      const staffDetails = await getStaffDetailsForUser(user._id);
      const token = signToken(user._id, staffDetails);
      return res.status(200).json({
        message: "Phone verified — you are now signed in",
        user: await buildAuthenticatedUserResponse(user, staffDetails),
        token,
        verified: true,
      });
    }

    // ── PURPOSE: REGISTRATION ───────────────────────────────────────────────
    // The phone belongs to the caller. Issue a short-lived token the sign-up
    // request must present to prove the phone was verified.
    const allowedRoles = ["buyer", "vendor", "supplier", "affiliate"];
    const finalRole = allowedRoles.includes(role) ? role : "buyer";
    const verificationToken = jwt.sign(
      { phone: normalizedPhone, purpose, role: finalRole },
      process.env.JWT_SECRET,
      { expiresIn: "15m" },
    );

    return res.status(200).json({
      message: "Phone verified successfully. Complete your registration.",
      verificationToken,
      phone: normalizedPhone,
      verified: true,
    });
  } catch (error) {
    console.error("Error verifying OTP:", error);
    return res.status(500).json({ message: "Failed to verify code" });
  }
};


// ─── WISHLIST ────────────────────────────────────────────────────────────────
const WISHLIST_MAX = 200;
const Product = require("../models/Product");
const { effectivePrice } = require("../utils/pricing.util");

async function wishlistResponse(userId) {
  const user = await User.findById(userId).select("wishlist").populate({
    path: "wishlist.product",
    select: "name price discountPrice media stockQuantity status vendor category",
    populate: [{ path: "vendor", select: "Fullname companyName" }, { path: "category", select: "name" }],
  });
  // Products that were deleted drop out of the list.
  return (user?.wishlist || []).filter((w) => w.product).map((w) => ({
    product: w.product,
    savedPrice: w.savedPrice,
    savedAt: w.savedAt,
  }));
}

// @route GET /api/auth/wishlist
exports.getWishlist = async (req, res) => {
  try {
    return res.status(200).json({ items: await wishlistResponse(req.user.id) });
  } catch (error) {
    console.error("Wishlist load failed:", error);
    return res.status(500).json({ message: "Could not load your wishlist." });
  }
};

// @route POST /api/auth/wishlist   { productIds: [...] }  (adds; used to merge device lists too)
exports.addToWishlist = async (req, res) => {
  try {
    const ids = [...new Set((Array.isArray(req.body.productIds) ? req.body.productIds : [req.body.productId]).map(String))]
      .filter((id) => orm.isValidObjectId(id))
      .slice(0, WISHLIST_MAX);
    if (!ids.length) return res.status(400).json({ message: "Choose a product to save." });

    const products = await Product.find({ _id: { $in: ids }, status: { $in: ["ACTIVE", "OUT_OF_STOCK"] } }).select("price discountPrice");
    const user = await User.findById(req.user.id).select("wishlist");
    const have = new Set(user.wishlist.map((w) => String(w.product)));
    for (const p of products) {
      if (!have.has(String(p._id)) && user.wishlist.length < WISHLIST_MAX) {
        user.wishlist.push({ product: p._id, savedPrice: effectivePrice(p), savedAt: new Date() });
      }
    }
    await user.save({ validateBeforeSave: false });
    return res.status(200).json({ items: await wishlistResponse(req.user.id) });
  } catch (error) {
    console.error("Wishlist add failed:", error);
    return res.status(500).json({ message: "Could not save this product." });
  }
};

// @route DELETE /api/auth/wishlist/:productId
exports.removeFromWishlist = async (req, res) => {
  try {
    if (!orm.isValidObjectId(req.params.productId)) return res.status(404).json({ message: "Product not in your wishlist." });
    await User.updateOne({ _id: req.user.id }, { $pull: { wishlist: { product: req.params.productId } } });
    return res.status(200).json({ items: await wishlistResponse(req.user.id) });
  } catch (error) {
    console.error("Wishlist remove failed:", error);
    return res.status(500).json({ message: "Could not remove this product." });
  }
};

// ─── GUEST CHECKOUT ─────────────────────────────────────────────────────────
// Buyers can order without creating an account. Safety comes from proving
// the phone with a one-time code (rate-limited, 5 tries, single use): the
// order is tied to a real, reachable number, and only that number can see it.
// A new number gets a guest buyer account with a short session; an existing
// buyer number signs in to its own account. Seller, admin and partner numbers
// must sign in normally.
const GUEST_SESSION = "12h";

async function guestAccountFor(normalizedPhone) {
  return User.findOne({ phone: { $in: phoneVariants(normalizedPhone) } });
}

// @route POST /api/auth/guest/send-code   { phone, email? }
exports.guestSendCode = async (req, res) => {
  const normalizedPhone = normalizePhone(req.body?.phone);
  if (!normalizedPhone) {
    return res.status(400).json({
      message: `Enter a valid Rwandan phone number (e.g. 0788123456). ${describePhoneIssue(req.body?.phone) || ""}`.trim(),
    });
  }
  const existing = await guestAccountFor(normalizedPhone);
  if (existing && existing.role !== "buyer") {
    return res.status(409).json({ message: "This number belongs to a business account. Log in to buy with it, or use another number." });
  }
  req.body = { phone: normalizedPhone, purpose: "login", email: req.body?.email };
  return exports.sendOtp(req, res);
};

// @route POST /api/auth/guest/verify   { phone, code, fullName, email? }
exports.guestVerify = async (req, res) => {
  try {
    const { phone, code, fullName, email } = req.body || {};
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) return res.status(400).json({ message: "Enter a valid Rwandan phone number." });
    if (!code || !/^\d{6}$/.test(String(code).trim())) return res.status(400).json({ message: "Enter the 6-digit code we sent you." });
    const name = String(fullName || "").trim().slice(0, 120);
    // A name is needed only to create a new guest account; checking it first
    // keeps the code unused if it's missing.
    if (name.length < 2 && !(await guestAccountFor(normalizedPhone))) {
      return res.status(400).json({ message: "Enter your full name." });
    }

    const otpFailure = await consumeOtp(normalizedPhone, code, "login");
    if (otpFailure) return res.status(otpFailure.status).json({ message: otpFailure.message });

    let user = await guestAccountFor(normalizedPhone);
    if (user && user.role !== "buyer") {
      return res.status(409).json({ message: "This number belongs to a business account. Log in to buy with it." });
    }
    if (user && user.status && user.status !== "ACTIVE") {
      return res.status(403).json({ message: "This account is blocked or suspended. Contact MVEC support.", code: "ACCOUNT_BLOCKED" });
    }
    if (!user) {
      const normalizedEmail = String(email || "").trim().toLowerCase();
      const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) && !(await User.findOne({ email: normalizedEmail }));
      user = new User({
        Fullname: name,
        phone: normalizedPhone,
        email: emailOk ? normalizedEmail : undefined,
        role: "buyer",
        isGuest: true,
        isOnboarded: true,
        // Never used to sign in: the guest proves the phone each time, and
        // sets a real password later with "Forgot password".
        password: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10),
      });
      await user.save();
    }

    const token = signToken(user._id, null, user.isGuest ? GUEST_SESSION : "1d");
    return res.status(200).json({
      message: user.isGuest ? "Phone verified. You can place your order." : "Phone verified. You're signed in to your account.",
      token,
      user: await buildAuthenticatedUserResponse(user),
      guest: Boolean(user.isGuest),
    });
  } catch (error) {
    console.error("Guest verification failed:", error);
    return res.status(500).json({ message: "We could not verify your phone right now. Please try again." });
  }
};
