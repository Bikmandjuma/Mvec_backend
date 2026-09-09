const User = require("../models/User");
const Order = require("../models/Order");
const Product = require("../models/Product");

const USER_WITHOUT_PASSWORD = "-password -resetPasswordToken -resetPasswordExpires";

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

    if (role !== undefined) user.role = role;
    if (Fullname !== undefined) user.Fullname = Fullname;
    if (email !== undefined) user.email = email;
    if (phone !== undefined) user.phone = phone;
    if (gender !== undefined) user.gender = gender;
    if (status !== undefined) user.status = status;

    await user.save();
    return res.status(200).json({
      message: "User updated",
      user: mapUser(user),
    });
  } catch (error) {
    console.error("Error updating user:", error);
    if (error.code === 11000) {
      return res.status(409).json({ message: "Email or phone already in use" });
    }
    return res.status(500).json({ message: "Internal server error" });
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
