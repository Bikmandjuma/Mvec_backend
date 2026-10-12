const bcrypt = require("bcryptjs");
const Staff = require("../models/Staff");
const User = require("../models/User");
const Store = require("../models/Store");

const STAFF_ROLES = new Set(["STORE_MANAGER", "ORDER_MANAGER", "CATALOG_MANAGER"]);
const PERMISSIONS = {
  VIEWDASHBOARD: "canViewDashboard",
  MANAGEPRODUCTS: "canManageProducts",
  MANAGEORDERS: "canManageOrders",
  MANAGEPAYOUTS: "canManagePayouts",
  MANAGESTAFF: "canManageStaff",
  VIEWANALYTICS: "canViewAnalytics",
};

function normalizeRole(role) {
  const value = String(role || "staff").trim().toUpperCase();
  if (value === "MANAGER") return "STORE_MANAGER";
  if (value === "STAFF") return "ORDER_MANAGER";
  return value;
}

function permissionsFor(role, requested) {
  const defaults = {
    canViewDashboard: true,
    canManageProducts: role === "STORE_MANAGER" || role === "CATALOG_MANAGER",
    canManageOrders: role === "STORE_MANAGER" || role === "ORDER_MANAGER",
    canManagePayouts: false,
    canManageStaff: false,
    canViewAnalytics: role === "STORE_MANAGER",
    canManageSettings: false,
  };
  if (Array.isArray(requested)) {
    for (const slug of requested) {
      const key = PERMISSIONS[String(slug).replaceAll("_", "").toUpperCase()];
      if (key) defaults[key] = true;
    }
  } else if (requested && typeof requested === "object") {
    for (const [slug, value] of Object.entries(requested)) {
      const key = PERMISSIONS[slug.replaceAll("_", "").toUpperCase()] || slug;
      if (Object.hasOwn(defaults, key) && typeof value === "boolean") defaults[key] = value;
    }
  }
  return defaults;
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
    permissions: Object.entries(PERMISSIONS)
      .filter(([, key]) => permissions[key])
      .map(([slug]) => slug),
    permissionsMap: permissions,
    createdAt: staff.createdAt,
  };
}

async function storeForOwner(ownerId) {
  let store = await Store.findOne({ vendor: ownerId });
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
    if (await User.exists({ email })) {
      return res.status(409).json({ message: "An account with this email already exists." });
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
      permissions: permissionsFor(role, req.body.permissions),
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
      permissions: Object.keys(PERMISSIONS),
      createdAt: owner.createdAt,
    };
    return res.status(200).json({ staff: [ownerRow, ...staffList.map(staffDto)] });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

exports.updateStaffMember = async (req, res) => {
  try {
    const isObjectId = mongoose.Types.ObjectId.isValid(req.params.id);
    if (!isObjectId) return res.status(404).json({ message: "Invalid staff ID." });

    const staff = await Staff.findOne({
      $or: [{ _id: req.params.id }, { user: req.params.id }],
      vendorOwner: req.user.id,
    }).populate("user", "Fullname email phone");
    if (!staff) return res.status(404).json({ message: "Staff record not found." });

    if (req.body.role !== undefined || req.body.permission_role !== undefined) {
      const role = normalizeRole(req.body.role || req.body.permission_role);
      if (!STAFF_ROLES.has(role)) return res.status(400).json({ message: "Choose a valid staff role." });
      staff.role = role;
    }
    if (req.body.permissions !== undefined) {
      staff.permissions = permissionsFor(staff.role, req.body.permissions);
    }
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
    const isObjectId = mongoose.Types.ObjectId.isValid(req.params.id);
    if (!isObjectId) return res.status(404).json({ message: "Invalid staff ID." });

    const staff = await Staff.findOne({
      $or: [{ _id: req.params.id }, { user: req.params.id }],
      vendorOwner: req.user.id,
    });
    if (!staff) return res.status(404).json({ message: "Staff record not found." });

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
