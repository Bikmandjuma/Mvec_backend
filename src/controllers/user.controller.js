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
      const re = new RegExp(String(search).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
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

    // Roles are never switched on an existing account (see ROLE RULES below).
    if (role !== undefined && role !== user.role) {
      return res.status(400).json({ message: ROLE_LOCKED_MESSAGE });
    }

    if (status !== undefined) {
      const normalizedStatus = normalizeStatus(status);
      if (!USER_STATUS_VALUES.includes(normalizedStatus)) {
        return res.status(400).json({
          message: "Invalid status value provided",
          allowed: USER_STATUS_VALUES,
        });
      }
      if (normalizedStatus !== (user.status || "ACTIVE")) {
        if (String(user._id) === String(req.user._id || req.user.id)) {
          return res.status(400).json({ message: "You cannot block or suspend your own account." });
        }
        if (user.role === "super_admin") {
          return res.status(400).json({ message: "Use “Remove admin access” or “Restore admin access” for admins." });
        }
        if (user.role === "delivery" && normalizedStatus !== "ACTIVE") {
          const active = await activeDeliveriesOf(user._id);
          if (active) {
            return res.status(409).json({ message: `This courier has ${active} delivery${active === 1 ? "" : "s"} in progress. Assign ${active === 1 ? "it" : "them"} to another courier on Deliveries first.` });
          }
        }
      }
      user.status = normalizedStatus;
    }
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
// ROLE RULES — who gets which role, and how:
//   buyer      anyone, by signing up or checking out as a guest
//   seller     signs up as a seller; MVEC verifies the business (Sellers page)
//   supplier   signs up as a supplier; MVEC verifies the business (Suppliers page)
//   affiliate  signs up as an affiliate
//   courier    added by an admin with "Add courier": a new account for the
//              delivery partner, never a shopper's account (a courier must not
//              carry their own orders, and a buyer's orders and payments stay
//              with the buyer)
//   admin      added by an admin with "Add admin", confirmed with that admin's
//              own password; removed or restored the same way
// No account ever switches role: the role owns the account's store, wallet,
// orders or deliveries.
// ---------------------------------------------------------------------------
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const messaging = require("../services/messaging.service");
const { normalizePhone, phoneVariants } = require("../utils/sms.util");

const ROLE_LOCKED_MESSAGE = "Roles can't be switched on an existing account. Add couriers with “Add courier” and admins with “Add admin”. Sellers, suppliers and affiliates choose their role when they sign up.";
const OPEN_DELIVERY = ["DELIVERED", "COMPLETED", "CANCELLED", "RETURNED", "REFUNDED", "FAILED"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const activeDeliveriesOf = (courierId) => Order.countDocuments({ courier: courierId, orderStatus: { $nin: OPEN_DELIVERY } });
const actorId = (req) => String(req.user._id || req.user.id);

// Checks the name, email and phone for a new team account.
async function newAccountProblem({ name, email, phone }) {
  if (name.length < 2) return "Enter their full name.";
  if (!EMAIL_RE.test(email)) return "Enter a valid email address. We send their sign-in instructions there.";
  if (!phone) return "Enter a valid Rwandan phone number (e.g. 0788123456).";
  if (await User.exists({ email })) return "An account already uses this email. Couriers and admins get their own new account.";
  if (phone && (await User.exists({ phone: { $in: phoneVariants(phone) } }))) return "An account already uses this phone number. Couriers and admins get their own new account.";
  return null;
}

// Creates the account with an unusable random password: the person sets their
// own with "Forgot password", so no admin ever knows it.
async function createTeamAccount({ name, email, phone, role }) {
  const user = new User({
    Fullname: name,
    email,
    phone: phone ? `0${phone.slice(4)}` : undefined,
    role,
    isOnboarded: true,
    email_verified: true,
    password: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10),
  });
  await user.save();
  return user;
}

async function sendWelcome(user, what) {
  try {
    await messaging.sendEmail({
      to: user.email,
      subject: `You were added to MVEC as ${what}`,
      text: `Hello ${user.Fullname},\n\nMVEC added you as ${what}.\n\nTo start:\n1. Open the MVEC app or website and choose “Log in”.\n2. Tap “Forgot password?” and enter ${user.email}.\n3. Enter the code we email you and choose your password.\n\nIf you were not expecting this, you can ignore this email.`,
    });
    return true;
  } catch (err) {
    console.error("Welcome email failed:", err.message);
    return false;
  }
}

const createdMessage = (user, emailed) => (emailed
  ? `${user.Fullname} was added. We emailed ${user.email} how to set a password and sign in.`
  : `${user.Fullname} was added, but the welcome email could not be sent. Ask them to open MVEC, tap “Forgot password?” and enter ${user.email}.`);

const readTeamInput = (body) => ({
  name: String(body.fullName || body.Fullname || body.name || "").trim().slice(0, 120),
  email: String(body.email || "").trim().toLowerCase(),
  phone: body.phone ? normalizePhone(body.phone) : null,
});

// @desc    Add a courier (delivery partner) as a new account
// @route   POST /api/users/couriers   { fullName, email, phone }
// @access  Private (super_admin)
exports.createCourier = async (req, res) => {
  try {
    const input = readTeamInput(req.body);
    if (req.body.phone && !input.phone) return res.status(400).json({ message: "Enter a valid Rwandan phone number (e.g. 0788123456)." });
    const problem = await newAccountProblem(input);
    if (problem) return res.status(400).json({ message: problem });
    const user = await createTeamAccount({ ...input, role: "delivery" });
    const emailed = await sendWelcome(user, "a courier");
    return res.status(201).json({ message: createdMessage(user, emailed), user: mapUser(user), emailed });
  } catch (error) {
    console.error("Adding courier failed:", error);
    if (error.code === 11000) return res.status(409).json({ message: "Email or phone already in use" });
    return res.status(500).json({ message: "Could not add the courier. Please try again." });
  }
};

// Admin changes to the admin team need the acting admin's own password.
async function confirmActor(req) {
  const me = await User.findById(actorId(req));
  const password = req.body.currentPassword;
  return Boolean(me && me.password && typeof password === "string" && (await bcrypt.compare(password, me.password)));
}

// @desc    Add an admin as a new account
// @route   POST /api/users/admins   { fullName, email, phone, currentPassword }
// @access  Private (super_admin)
exports.createAdmin = async (req, res) => {
  try {
    if (!(await confirmActor(req))) return res.status(403).json({ message: "Enter your own password to add an admin.", code: "PASSWORD_REQUIRED" });
    const input = readTeamInput(req.body);
    if (req.body.phone && !input.phone) return res.status(400).json({ message: "Enter a valid Rwandan phone number (e.g. 0788123456)." });
    const problem = await newAccountProblem(input);
    if (problem) return res.status(400).json({ message: problem });
    const user = await createTeamAccount({ ...input, role: "super_admin" });
    const emailed = await sendWelcome(user, "an administrator");
    return res.status(201).json({ message: createdMessage(user, emailed), user: mapUser(user), emailed });
  } catch (error) {
    console.error("Adding admin failed:", error);
    if (error.code === 11000) return res.status(409).json({ message: "Email or phone already in use" });
    return res.status(500).json({ message: "Could not add the admin. Please try again." });
  }
};

// @desc    Remove or restore an admin's access. Removing blocks the account,
//          so it can no longer sign in; past actions stay in the audit log.
// @route   POST /api/users/:id/admin-access   { active: boolean, currentPassword }
// @access  Private (super_admin)
exports.setAdminAccess = async (req, res) => {
  try {
    const active = req.body.active === true;
    const user = await User.findById(req.params.id);
    if (!user || user.role !== "super_admin") return res.status(404).json({ message: "Admin not found." });
    if (String(user._id) === actorId(req)) return res.status(400).json({ message: "You cannot change your own admin access. Ask another admin." });
    if (!(await confirmActor(req))) return res.status(403).json({ message: `Enter your own password to ${active ? "restore" : "remove"} admin access.`, code: "PASSWORD_REQUIRED" });
    if (!active) {
      const others = await User.countDocuments({ role: "super_admin", status: "ACTIVE", _id: { $ne: user._id } });
      if (!others) return res.status(400).json({ message: "MVEC needs at least one active admin." });
    }
    user.status = active ? "ACTIVE" : "BLOCK";
    await user.save();
    return res.status(200).json({ message: active ? `${user.Fullname} has admin access again.` : `${user.Fullname} no longer has admin access.`, user: mapUser(user) });
  } catch (error) {
    console.error("Changing admin access failed:", error);
    return res.status(500).json({ message: "Could not change admin access. Please try again." });
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

    // A seller only finds their own customers and orders; admins find anyone.
    const isAdmin = req.user.role === "super_admin";
    const sellerId = req.vendorId || req.user._id;
    const customerIds = isAdmin ? null : await Order.distinct("user", { "items.vendor": sellerId });
    const [users, stores, orders] = await Promise.all([
      User.find({
        $or: [{ Fullname: re }, { email: re }, { phone: re }, { companyName: re }],
        ...(isAdmin ? {} : { _id: { $in: customerIds } }),
      })
        .select(USER_WITHOUT_PASSWORD)
        .limit(10),
      Store.find({
        $or: [{ storeName: re }, { slug: re }, { businessCategory: re }],
      })
        .select("storeName slug logo businessCategory vendor status")
        .limit(8),
      Order.find({ orderNumber: re, ...(isAdmin ? {} : { "items.vendor": sellerId }) })
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
        email: isAdmin ? owner?.email : undefined,
        phone: isAdmin ? owner?.phone : undefined,
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
