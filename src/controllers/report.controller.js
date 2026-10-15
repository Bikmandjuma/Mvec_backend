const Order = require("../models/Order");
const User = require("../models/User");
const Product = require("../models/Product");
const Vendor = require("../models/Vendor");
const Payment = require("../models/Payment");

const rangeStart = (range) => {
  const now = new Date();
  const map = {
    "24h": 1,
    "7d": 7,
    "30d": 30,
    "90d": 90,
    "1y": 365,
  };
  const days = map[range] || 30;
  const d = new Date(now);
  d.setDate(d.getDate() - days);
  return d;
};

// @desc    Platform-wide report metrics / summaries
// @route   GET /api/reports/summary?range=30d&vendorId=
// @access  Private
exports.getSummary = async (req, res) => {
  try {
    const range = req.query.range || "30d";
    const since = rangeStart(range);
    const isAdmin = req.user.role === "super_admin";
    const isVendor = req.user.role === "vendor";

    // Vendors scope reports to orders containing their own products.
    let orderQuery = {};
    let productWindow = {};
    if (isVendor) {
      const productIds = await Product.find({ vendor: req.user._id }).distinct("_id");
      orderQuery = { "items.product": { $in: productIds } };
      productWindow = { vendor: req.user._id };
    }

    const [allOrders, periodOrders, users, vendors, productsLowStock, payments] =
      await Promise.all([
        Order.countDocuments(orderQuery),
        Order.countDocuments({ ...orderQuery, createdAt: { $gte: since } }),
        isAdmin ? User.countDocuments() : Promise.resolve(null),
        isAdmin ? Vendor.countDocuments() : Promise.resolve(null),
        Product.countDocuments({ ...productWindow, stockQuantity: { $lte: 5 } }),
        // Sellers: money from their own sales (settlements); admins: every payment.
        isAdmin ? Payment.find({ createdAt: { $gte: since } }).select("amount status") : Promise.resolve([]),
      ]);

    const orders = await Order.find({ ...orderQuery, createdAt: { $gte: since } }).select(
      "totalAmount paymentStatus orderStatus createdAt"
    );

    const gmv = orders.reduce((s, o) => s + Number(o.totalAmount || 0), 0);
    const successfulPayments = payments.filter((p) =>
      ["PAID", "CONFIRMED", "SUCCESS"].includes(String(p.status).toUpperCase())
    );
    const Settlement = require("../models/Settlement");
    const settlements = await Settlement.find({ ...(isVendor ? { vendor: req.user._id } : {}), createdAt: { $gte: since }, status: { $nin: ["CANCELLED"] } }).select("grossAmount commissionAmount status").lean();
    const paymentVolume = isAdmin
      ? successfulPayments.reduce((s, p) => s + Number(p.amount || 0), 0)
      : settlements.filter((x) => x.status !== "REFUNDED").reduce((s, x) => s + Number(x.grossAmount || 0), 0);
    const commission = settlements.filter((x) => x.status !== "REFUNDED").reduce((s, x) => s + Number(x.commissionAmount || 0), 0);
    const refunds = orders.filter((o) => o.paymentStatus === "REFUNDED").length;

    return res.status(200).json({
      range,
      metrics: {
        grossSales: gmv,
        orders: periodOrders,
        totalOrders: allOrders,
        customers: users,
        activeVendors: vendors,
        lowStockProducts: productsLowStock,
        paymentVolume,
        commission: Math.round(commission),
        refunds,
      },
    });
  } catch (error) {
    console.error("Error generating report summary:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// @desc    Revenue-over-time series for charts
// @route   GET /api/reports/revenue?range=30d
// @access  Private
exports.getRevenueSeries = async (req, res) => {
  try {
    const range = req.query.range || "30d";
    const since = rangeStart(range);

    // Sellers only see days with orders containing their products.
    let scope = {};
    if (req.user.role === "vendor") {
      const productIds = await Product.find({ vendor: req.user._id }).distinct("_id");
      scope = { "items.product": { $in: productIds } };
    }
    const orders = await Order.find({ ...scope, createdAt: { $gte: since } }).select(
      "totalAmount createdAt"
    );

    const daily = {};
    for (const o of orders) {
      const key = o.createdAt.toISOString().slice(0, 10);
      daily[key] = (daily[key] || 0) + Number(o.totalAmount || 0);
    }
    const labels = Object.keys(daily).sort();
    const series = labels.map((k) => daily[k]);

    return res.status(200).json({ labels, series });
  } catch (error) {
    console.error("Error generating revenue series:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};
