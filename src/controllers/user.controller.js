const User = require("../models/User");
const Order = require("../models/Order");
const Product = require("../models/Product");
const Store = require("../models/Store");

const USER_WITHOUT_PASSWORD = "-password -resetPasswordToken -resetPasswordExpires";

// Account statuses the platform exposes. Legacy spellings are normalized onto
// these canonical values when a PATCH arrives.
const USER_STATUS_VALUES = ["ACTIVE", "SUSPEND", "BLOCK", "INVESTIGATE"];
const USER_STATUS_LEGACY = {
  SUSPENDED: "SUSPEND",
  BLOCKED: "BLOCK",
  INVESTIGATION: "INVESTIGATE",
};

// Normalize any casing/spacing of a status into the canonical uppercase form,
// mapping legacy values (SUSPENDED/BLOCKED/INVESTIGATION) onto the new ones.
function normalizeStatus(value) {
  const raw = String(value || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  return USER_STATUS_LEGACY[raw] || raw;
}

function mapUser(u) {
  return {
    id: u._id,
    name: u.Fullname,
    fullName: u.Fullname,
    email: u.email,
    phone: u.phone,
    gender: u.gender,
    role: u.role,
    companyName: u.companyName,
    email_verified: u.email_verified,
    status: u.status || "ACTIVE",
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

// @desc    Admin list users with role/status filters + pagination
// @route   GET /api/users?role=&status=&search=&page=&limit=
// @access  Private (super_admin)
exports.adminListUsers = async (req, res) => {
  try {
    const { role, status, search } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));

    const query = {};
    if (role) query.role = role;
    if (status) query.status = status;
    if (search) {
      const re = new RegExp(search, "i");
      query.$or = [{ Fullname: re }, { email: re }, { phone: re }];
    }

    const total = await User.countDocuments(query);
    const users = await User.find(query)
      .select(USER_WITHOUT_PASSWORD)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    return res.status(200).json({
      data: users.map(mapUser),
      meta: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error("Error listing users:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// @desc    Admin get a single user
// @route   GET /api/users/:id
// @access  Private (super_admin)
exports.adminGetUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select(USER_WITHOUT_PASSWORD);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    return res.status(200).json({ user: mapUser(user) });
  } catch (error) {
    console.error("Error fetching user:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// @desc    Admin update a user (role/status, profile)
// @route   PATCH /api/users/:id
// @access  Private (super_admin)
exports.adminUpdateUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const { role, status, Fullname, email, phone, gender } = req.body;

    if (status !== undefined) {
      const normalizedStatus = normalizeStatus(status);
      if (!USER_STATUS_VALUES.includes(normalizedStatus)) {
        return res.status(400).json({
          message: "Invalid status value provided",
          allowed: USER_STATUS_VALUES,
        });
      }
      user.status = normalizedStatus;
    }

    if (role !== undefined) user.role = role;
    if (Fullname !== undefined) user.Fullname = Fullname;
    if (email !== undefined) user.email = email;
    if (phone !== undefined) user.phone = phone;
    if (gender !== undefined) user.gender = gender;

    await user.save();

    return res.status(200).json({
      message: "User updated",
      user: mapUser(user),
    });
  } catch (error) {
    console.error("API Error during user PATCH:", error);
    if (error.code === 11000) {
      return res.status(409).json({ message: "Email or phone already in use" });
    }
    if (error.name === "ValidationError") {
      return res.status(400).json({ message: error.message });
    }
    if (error.name === "CastError") {
      return res.status(400).json({ message: "Invalid user id format" });
    }
    return res.status(500).json({ message: "Internal Server Error", error: error.message });
  }
};

// @desc    Vendor list of customers (buyers who ordered this vendor's products)
// @route   GET /api/users/vendor/customers
// @access  Private (vendor)
exports.listVendorCustomers = async (req, res) => {
  try {
    const vendorId = req.user._id;
    const productIds = await Product.find({ vendor: vendorId }).distinct("_id");

    const orders = await Order.find({ "items.product": { $in: productIds } })
      .select("user totalAmount orderStatus paymentStatus createdAt")
      .sort({ createdAt: -1 });

    // Aggregate per buyer: order count, total spent, last purchase date.
    const byUser = {};
    for (const o of orders) {
      const id = String(o.user);
      if (!byUser[id]) {
        byUser[id] = { userId: o.user, orders: 0, total: 0, lastPurchase: o.createdAt };
      }
      byUser[id].orders += 1;
      byUser[id].total += Number(o.totalAmount || 0);
      if (o.createdAt > byUser[id].lastPurchase) byUser[id].lastPurchase = o.createdAt;
    }

    const ids = Object.values(byUser).map((c) => c.userId);
    const users = await User.find({ _id: { $in: ids } }).select(USER_WITHOUT_PASSWORD);

    const customers = users.map((u) => {
      const agg = byUser[String(u._id)];
      return {
        id: u._id,
        name: u.Fullname,
        email: u.email,
        phone: u.phone,
        orders: agg.orders,
        totalSpent: agg.total,
        lastPurchase: agg.lastPurchase,
      };
    });

    return res.status(200).json({
      data: customers,
      meta: { total: customers.length },
    });
  } catch (error) {
    console.error("Error listing vendor customers:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// @desc    Search platform users / stores / orders for abuse report forms
// @route   GET /api/users/search?q=query
// @access  Private (vendor or admin)
exports.searchUsers = async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || !String(q).trim() || String(q).trim().length < 2) {
      return res.status(200).json({ data: [], meta: { total: 0 } });
    }

    const query = String(q).trim();
    const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

    const [users, stores, orders] = await Promise.all([
      User.find({
        $or: [{ Fullname: re }, { email: re }, { phone: re }, { companyName: re }],
      })
        .select(USER_WITHOUT_PASSWORD)
        .limit(10),
      Store.find({
        $or: [{ storeName: re }, { slug: re }, { businessCategory: re }],
      })
        .select("storeName slug logo businessCategory vendor status")
        .limit(8),
      Order.find({ orderNumber: re })
        .select("orderNumber user totalAmount createdAt")
        .populate("user", "Fullname email phone companyName role")
        .limit(8),
    ]);

    const storeVendorIds = stores.map((s) => s.vendor).filter(Boolean);
    const storeOwners = storeVendorIds.length
      ? await User.find({ _id: { $in: storeVendorIds } }).select("Fullname email phone companyName role status")
      : [];
    const ownerById = {};
    for (const o of storeOwners) ownerById[String(o._id)] = o;

    const data = [];

    for (const u of users) {
      data.push({
        kind: "user",
        targetUserId: u._id,
        label: u.Fullname,
        subtitle: [u.role, u.companyName].filter(Boolean).join(" · "),
        email: u.email,
        phone: u.phone,
        role: u.role,
        companyName: u.companyName || "",
      });
    }

    for (const s of stores) {
      const owner = ownerById[String(s.vendor)];
      data.push({
        kind: "store",
        targetUserId: s.vendor,
        label: s.storeName,
        subtitle: `${s.businessCategory || "Store"} · ${owner?.Fullname || ""}`.trim().replace(/^ ·| · $/g, ""),
        email: owner?.email,
        phone: owner?.phone,
        role: "vendor",
        companyName: owner?.companyName || "",
        store: { id: s._id, slug: s.slug, logo: s.logo },
      });
    }

    for (const o of orders) {
      const buyer = o.user && typeof o.user === "object" ? o.user : null;
      data.push({
        kind: "order",
        targetUserId: buyer ? buyer._id : o.user,
        orderId: o._id,
        label: `Order ${o.orderNumber}`,
        subtitle: `${buyer?.Fullname || "Customer"} · ${Number(o.totalAmount).toLocaleString("en-RW")} RWF`,
        role: buyer?.role || "buyer",
        companyName: buyer?.companyName || "",
      });
    }

    // Deduplicate by targetUserId+kind, keep first occurrence (users first)
    const seen = new Set();
    const deduped = data.filter((d) => {
      const key = `${d.kind}:${String(d.targetUserId)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return res.status(200).json({
      data: deduped.slice(0, 20),
      meta: { total: deduped.length },
    });
  } catch (error) {
    console.error("Error searching users:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};
