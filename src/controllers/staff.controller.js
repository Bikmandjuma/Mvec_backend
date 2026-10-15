const bcrypt = require("bcryptjs");
const orm = require("../database/orm");
const Staff = require("../models/Staff");
const User = require("../models/User");
const Store = require("../models/Store");
const { getPrimaryStore } = require("../utils/vendorStore.util");

const StaffActivity = require("../models/StaffActivity");
const staffAccess = require("../services/staffAccess.service");

const STAFF_ROLES = new Set(Object.keys(staffAccess.ROLE_PRESETS));
// Legacy slugs (VIEW_DASHBOARD, MANAGE_ORDERS...) map onto the permission keys.
const SLUG_TO_KEY = Object.fromEntries(staffAccess.KEYS.map((k) => [k.replace(/^can/, "").toUpperCase(), k]));

function normalizeRole(role) {
  const value = String(role || "staff").trim().toUpperCase();
  if (value === "MANAGER") return "STORE_MANAGER";
  if (value === "STAFF") return "ORDER_MANAGER";
  return value;
}

// Role preset, with optional overrides: an array of slugs/keys to turn on, or
// an object { key: boolean } (as sent by the Team page's permission editor).
function permissionsFor(role, requested) {
  const perms = staffAccess.presetFor(role);
  const keyOf = (slug) => (staffAccess.KEYS.includes(slug) ? slug : SLUG_TO_KEY[String(slug).replace(/[^a-zA-Z]/g, "").toUpperCase()]);
  if (Array.isArray(requested)) {
    staffAccess.KEYS.forEach((k) => { perms[k] = false; });
    requested.forEach((slug) => { const k = keyOf(slug); if (k) perms[k] = true; });
  } else if (requested && typeof requested === "object") {
    for (const [slug, value] of Object.entries(requested)) {
      const k = keyOf(slug);
      if (k && typeof value === "boolean") perms[k] = value;
    }
  }
  perms.canViewDashboard = true;
  return perms;
}

const plainPerms = (staff) => staff.permissions?.toObject?.() || staff.permissions || {};

// A staff member with team access can't edit themselves or hand out access
// they don't have themselves.
function staffActorProblem(req, target, nextPerms) {
  const actor = req.staffMember;
  if (!actor) return null;
  if (target && String(target._id) === String(actor._id)) return "You can't change your own access. Ask the store owner.";
  if (nextPerms) {
    const mine = plainPerms(actor);
    const extra = staffAccess.KEYS.find((k) => nextPerms[k] && !mine[k]);
    if (extra) return "You can only give access you have yourself.";
  }
  return null;
}

function staffDto(staff) {
  const user = staff.user || {};
  const permissions = staff.permissions?.toObject?.() || staff.permissions || {};
  return {
    _id: staff._id,
    id: staff._id,
    name: user.Fullname || "Team member",
    email: user.email || "",
    phone: user.phone || null,
    role: staff.role,
    permission_role: staff.role,
    status: staff.status,
    active: staff.status === "ACTIVE",
    store_id: staff.store,
    vendor_id: staff.store,
    user_id: user._id || staff.user,
    permissions: staffAccess.KEYS.filter((k) => permissions[k]),
    permissionsMap: Object.fromEntries(staffAccess.KEYS.map((k) => [k, Boolean(permissions[k])])),
    customized: staffAccess.KEYS.some((k) => Boolean(permissions[k]) !== staffAccess.presetFor(staff.role)[k]),
    lastActiveAt: staff.lastActiveAt || null,
    createdAt: staff.createdAt,
  };
}

async function storeForOwner(ownerId) {
  let store = await getPrimaryStore(ownerId);
  if (!store) {
    const Vendor = require("../models/Vendor");
    const v = await Vendor.findOne({ user: ownerId });
    if (v) {
      const createSlug = (text) =>
        text
          .toString()
          .toLowerCase()
          .trim()
          .replace(/\s+/g, "-")
          .replace(/[^\w\-]+/g, "")
          .replace(/\-\-+/g, "-");
      let slug = createSlug(v.businessName);
      const exists = await Store.findOne({ slug });
      if (exists) slug = `${slug}-${Date.now().toString(36)}`;
      store = await Store.create({
        vendor: ownerId,
        isPrimary: true,
        storeName: v.businessName,
        slug,
        contactEmail: v.email,
        contactPhone: v.phone,
        status: "ACTIVE",
      });
    }
  }
  return store;
}

exports.addStaffMember = async (req, res) => {
  let createdUser;
  try {
    const name = String(req.body.name || req.body.Fullname || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = req.body.password;
    const phone = req.body.phone || req.body.phoneNumber || null;
    const role = normalizeRole(req.body.role || req.body.permission_role);
    if (!name || !email || !email.includes("@") || typeof password !== "string" || password.length < 8) {
      return res.status(400).json({
        message: "Full name, valid email, and a password of at least 8 characters are required.",
      });
    }
    if (!STAFF_ROLES.has(role)) {
      return res.status(400).json({ message: "Choose a valid staff role." });
    }

    const store = await storeForOwner(req.user.id);
    if (!store) {
      return res.status(404).json({ message: "You must create a store before adding staff." });
    }
    const permissions = permissionsFor(role, req.body.permissions);
    const problem = staffActorProblem(req, null, permissions);
    if (problem) return res.status(403).json({ message: problem });

    const existing = await User.findOne({ email }).select("+isVendorStaff");
    if (existing) {
      // Someone removed from this team earlier can be added back.
      const leftThisTeam = existing.isVendorStaff && !(await Staff.exists({ user: existing._id }));
      if (!leftThisTeam) return res.status(409).json({ message: "An account with this email already exists." });
      existing.Fullname = name;
      existing.password = await bcrypt.hash(password, 10);
      existing.status = "ACTIVE";
      existing.companyName = store.storeName;
      if (phone) existing.phone = phone;
      await existing.save();
      const staff = await Staff.create({ store: store._id, vendorOwner: req.user.id, user: existing._id, role, permissions, status: "ACTIVE" });
      await staff.populate("user", "Fullname email phone");
      return res.status(201).json({ message: "Team member added back with a new password.", staff: staffDto(staff) });
    }

    const userData = {
      Fullname: name,
      email,
      password: await bcrypt.hash(password, 10),
      role: "vendor",
      companyName: store.storeName,
      isVendorStaff: true,
      status: "ACTIVE",
    };
    if (phone) userData.phone = phone;

    createdUser = await User.create(userData);
    const staff = await Staff.create({
      store: store._id,
      vendorOwner: req.user.id,
      user: createdUser._id,
      role,
      permissions,
      status: "ACTIVE",
    });
    await staff.populate("user", "Fullname email phone");
    return res.status(201).json({
      message: "Staff account created successfully.",
      staff: staffDto(staff),
    });
  } catch (error) {
    if (createdUser) await User.deleteOne({ _id: createdUser._id });
    if (error.code === 11000) {
      return res.status(409).json({ message: "An account with this email already exists." });
    }
    return res.status(500).json({ message: error.message });
  }
};

exports.getStoreStaff = async (req, res) => {
  try {
    const store = await storeForOwner(req.user.id);
    if (!store) return res.status(404).json({ message: "Store not found." });

    const [staffList, owner] = await Promise.all([
      Staff.find({ store: store._id }).populate("user", "Fullname email phone").sort({ createdAt: 1 }),
      User.findById(req.user.id).select("Fullname email phone"),
    ]);
    const ownerRow = {
      _id: owner._id,
      name: owner.Fullname,
      email: owner.email || "",
      phone: owner.phone || null,
      role: "OWNER",
      active: true,
      permissions: staffAccess.KEYS,
      createdAt: owner.createdAt,
    };
    return res.status(200).json({
      staff: [ownerRow, ...staffList.map(staffDto)],
      roles: Object.entries(staffAccess.ROLE_PRESETS).map(([key, perms]) => ({ key, permissions: perms })),
      permissions: staffAccess.PERMISSIONS.map(([key, label]) => ({ key, label })),
      viewer: req.staffMember ? { staffId: req.staffMember._id, permissionsMap: plainPerms(req.staffMember) } : { owner: true },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

exports.updateStaffMember = async (req, res) => {
  try {
    const isObjectId = orm.Types.ObjectId.isValid(req.params.id);
    if (!isObjectId) return res.status(404).json({ message: "Invalid staff ID." });

    const staff = await Staff.findOne({
      $or: [{ _id: req.params.id }, { user: req.params.id }],
      vendorOwner: req.user.id,
    }).populate("user", "Fullname email phone");
    if (!staff) return res.status(404).json({ message: "Staff record not found." });
    const selfProblem = staffActorProblem(req, staff);
    if (selfProblem) return res.status(403).json({ message: selfProblem });

    if (req.body.name !== undefined || req.body.phone !== undefined) {
      const name = String(req.body.name ?? staff.user?.Fullname ?? "").trim();
      if (!name) return res.status(400).json({ message: "Name can't be empty." });
      const set = { Fullname: name };
      if (req.body.phone !== undefined) set.phone = req.body.phone || null;
      await User.updateOne({ _id: staff.user._id, isVendorStaff: true }, { $set: set });
      staff.user.Fullname = name;
      if (req.body.phone !== undefined) staff.user.phone = set.phone;
    }

    if (req.body.role !== undefined || req.body.permission_role !== undefined) {
      const role = normalizeRole(req.body.role || req.body.permission_role);
      if (!STAFF_ROLES.has(role)) return res.status(400).json({ message: "Choose a valid staff role." });
      staff.role = role;
      // A new role starts from its preset unless permissions are sent too.
      if (req.body.permissions === undefined) staff.permissions = permissionsFor(role);
    }
    if (req.body.permissions !== undefined) {
      staff.permissions = permissionsFor(staff.role, req.body.permissions);
    }
    const permProblem = staffActorProblem(req, null, plainPerms(staff));
    if (permProblem) return res.status(403).json({ message: permProblem });
    if (req.body.status !== undefined || req.body.active !== undefined) {
      const active = req.body.active === undefined
        ? req.body.status === "ACTIVE"
        : req.body.active === true;
      staff.status = active ? "ACTIVE" : "SUSPENDED";
      if (staff.user?._id) {
        await User.updateOne(
          { _id: staff.user._id, isVendorStaff: true },
          { $set: { status: active ? "ACTIVE" : "SUSPEND" } },
        );
      }
    }

    await staff.save();
    return res.status(200).json({ message: "Staff member updated.", staff: staffDto(staff) });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

exports.removeStaffMember = async (req, res) => {
  try {
    const isObjectId = orm.Types.ObjectId.isValid(req.params.id);
    if (!isObjectId) return res.status(404).json({ message: "Invalid staff ID." });

    const staff = await Staff.findOne({
      $or: [{ _id: req.params.id }, { user: req.params.id }],
      vendorOwner: req.user.id,
    });
    if (!staff) return res.status(404).json({ message: "Staff record not found." });
    const problem = staffActorProblem(req, staff);
    if (problem) return res.status(403).json({ message: problem });

    await Staff.deleteOne({ _id: staff._id });
    if (staff.user) {
      await User.updateOne(
        { _id: staff.user, isVendorStaff: true },
        { $set: { status: "SUSPEND" } },
      );
    }
    return res.status(200).json({ message: "Staff access removed successfully." });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Owner sets a new temporary password for a team member
// @route   POST /api/staff/:id/password
exports.resetStaffPassword = async (req, res) => {
  try {
    if (!orm.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({ message: "Invalid staff ID." });
    const { password } = req.body;
    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ message: "The new password must be at least 8 characters." });
    }
    const staff = await Staff.findOne({ $or: [{ _id: req.params.id }, { user: req.params.id }], vendorOwner: req.user.id });
    if (!staff) return res.status(404).json({ message: "Staff record not found." });
    const problem = staffActorProblem(req, staff);
    if (problem) return res.status(403).json({ message: problem });
    await User.updateOne(
      { _id: staff.user, isVendorStaff: true },
      { $set: { password: await bcrypt.hash(password, 10), lastPasswordChangeAt: new Date() } },
    );
    return res.status(200).json({ message: "Password reset. Share the new password with your team member securely." });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    What team members changed recently
// @route   GET /api/staff/activity?staffId=&limit=
exports.getStaffActivity = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const filter = { vendor: req.user.id };
    if (req.query.staffId && orm.Types.ObjectId.isValid(req.query.staffId)) filter.staff = req.query.staffId;
    const rows = await StaffActivity.find(filter).sort({ createdAt: -1 }).limit(limit).populate("user", "Fullname email");
    return res.status(200).json({
      activity: rows.map((a) => ({
        id: a._id, staffId: a.staff, name: a.user?.Fullname || "Team member", email: a.user?.email || "",
        action: a.action, method: a.method, path: a.path, at: a.createdAt,
      })),
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
