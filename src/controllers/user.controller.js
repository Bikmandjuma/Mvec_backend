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

// ---------------------------------------------------------------------------
// Vendor customers: buyers (accounts) and guest customers from manual orders,
// with spend counted on this seller's items only.
// ---------------------------------------------------------------------------
const NOT_COUNTED = ["CANCELLED", "REFUNDED", "FAILED", "RETURNED"];
const customerKey = (o) => (o.user ? `user:${o.user._id || o.user}` : o.customer?.phone ? `guest:${String(o.customer.phone).replace(/\D/g, "")}` : null);

async function vendorOrdersFor(req) {
  const ids = [String(req.user._id)];
  if (req.vendorId && String(req.vendorId) !== ids[0]) ids.push(String(req.vendorId));
  const orders = await Order.find({ "items.vendor": { $in: ids } }).sort({ createdAt: -1 });
  return orders.map((o) => {
    const items = (o.items || []).filter((i) => i.vendor && ids.includes(String(i.vendor)));
    const parcels = (o.shippingBreakdown || []).filter((p) => p.vendor && ids.includes(String(p.vendor)));
    return {
      order: o,
      items,
      subtotal: items.reduce((t, i) => t + Number(i.price) * Number(i.quantity), 0),
      delivery: parcels.reduce((t, p) => t + Number(p.fee || 0), 0),
    };
  });
}

function summarize(rows) {
  const byKey = new Map();
  for (const row of rows) {
    const key = customerKey(row.order);
    if (!key) continue;
    const c = byKey.get(key) || {
      key, userId: row.order.user || null, guest: !row.order.user,
      name: row.order.customer?.name || null, email: row.order.customer?.email || null, phone: row.order.customer?.phone || null,
      city: row.order.shippingAddress?.district || row.order.shippingAddress?.city || null,
      orders: 0, cancelled: 0, totalSpent: 0, firstPurchase: row.order.createdAt, lastPurchase: row.order.createdAt,
      sources: new Set(),
    };
    c.sources.add(row.order.source || "ONLINE");
    if (NOT_COUNTED.includes(row.order.orderStatus)) c.cancelled += 1;
    else { c.orders += 1; c.totalSpent += row.subtotal; }
    if (row.order.createdAt < c.firstPurchase) c.firstPurchase = row.order.createdAt;
    if (row.order.createdAt > c.lastPurchase) { c.lastPurchase = row.order.createdAt; c.city = row.order.shippingAddress?.district || row.order.shippingAddress?.city || c.city; }
    byKey.set(key, c);
  }
  return [...byKey.values()];
}

// @desc    Vendor list of customers (buyers who ordered this vendor's products)
// @route   GET /api/users/vendor/customers
// @access  Private (vendor)
exports.listVendorCustomers = async (req, res) => {
  try {
    const customers = summarize(await vendorOrdersFor(req));
    const accounts = await User.find({ _id: { $in: customers.filter((c) => c.userId).map((c) => c.userId) } }).select(USER_WITHOUT_PASSWORD);
    const byId = new Map(accounts.map((u) => [String(u._id), u]));
    const data = customers.map((c) => {
      const u = c.userId ? byId.get(String(c.userId)) : null;
      return {
        id: c.userId ? String(c.userId) : c.key,
        key: c.key,
        guest: c.guest,
        name: u?.Fullname || c.name || "Customer",
        email: u?.email || c.email || null,
        phone: u?.phone || c.phone || null,
        city: c.city,
        orders: c.orders,
        cancelledOrders: c.cancelled,
        totalSpent: c.totalSpent,
        averageOrder: c.orders ? Math.round(c.totalSpent / c.orders) : 0,
        firstPurchase: c.firstPurchase,
        lastPurchase: c.lastPurchase,
        sources: [...c.sources],
      };
    }).sort((a, b) => b.totalSpent - a.totalSpent);

    return res.status(200).json({ data, meta: { total: data.length, repeat: data.filter((c) => c.orders > 1).length } });
  } catch (error) {
    console.error("Error listing vendor customers:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// @desc    One customer's history with this vendor
// @route   GET /api/users/vendor/customers/:key   (user id, or "guest:<phone digits>")
// @access  Private (vendor)
exports.getVendorCustomer = async (req, res) => {
  try {
    const raw = String(req.params.key);
    const key = /^[a-f0-9]{24}$/i.test(raw) ? `user:${raw}` : raw;
    const rows = (await vendorOrdersFor(req)).filter((r) => customerKey(r.order) === key);
    if (!rows.length) return res.status(404).json({ message: "Customer not found." });
    const [summary] = summarize(rows);
    const user = summary.userId ? await User.findById(summary.userId).select(USER_WITHOUT_PASSWORD) : null;
    return res.status(200).json({
      customer: {
        id: summary.userId ? String(summary.userId) : summary.key,
        key: summary.key,
        guest: summary.guest,
        name: user?.Fullname || summary.name || "Customer",
        email: user?.email || summary.email || null,
        phone: user?.phone || summary.phone || null,
        city: summary.city,
        orders: summary.orders,
        cancelledOrders: summary.cancelled,
        totalSpent: summary.totalSpent,
        averageOrder: summary.orders ? Math.round(summary.totalSpent / summary.orders) : 0,
        firstPurchase: summary.firstPurchase,
        lastPurchase: summary.lastPurchase,
      },
      orders: rows.map((r) => ({
        _id: r.order._id,
        orderNumber: r.order.orderNumber,
        createdAt: r.order.createdAt,
        orderStatus: r.order.orderStatus,
        paymentStatus: r.order.paymentStatus,
        source: r.order.source || "ONLINE",
        items: r.items.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price })),
        subtotal: r.subtotal,
        delivery: r.delivery,
      })),
    });
  } catch (error) {
    console.error("Error loading vendor customer:", error);
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
