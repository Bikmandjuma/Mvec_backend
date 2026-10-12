const mongoose = require("mongoose");
const Order = require("../models/Order");
const Cart = require("../models/Cart");
const Product = require("../models/Product");
const Payment = require("../models/Payment");
const Settlement = require("../models/Settlement");
const LedgerEntry = require("../models/LedgerEntry");
const VendorWallet = require("../models/VendorWallet");
const payoutController = require("./payout.controller");
const socketService = require("../services/socket.service");
// const financialService = require("../services/financial.service");
const affiliateAttribution = require("../services/affiliateAttribution.service");

// A cancelled/refunded/returned/failed order can never pay out affiliate
// commission: reverse whatever is still standing (idempotent per order).
const VOIDING_ORDER_STATUSES = ["CANCELLED", "REFUNDED", "RETURNED", "FAILED"];
const VOIDING_PAYMENT_STATUSES = ["REFUNDED", "FAILED"];
async function reverseCommissionIfVoided(order) {
  if (
    !VOIDING_ORDER_STATUSES.includes(order.orderStatus) &&
    !VOIDING_PAYMENT_STATUSES.includes(order.paymentStatus)
  ) {
    return;
  }
  try {
    await affiliateAttribution.reverseOrderCommission({
      orderId: order._id,
      key: `order-void:${order._id}`,
      reason: `Order ${order.orderStatus}/${order.paymentStatus}`,
    });
  } catch (err) {
    console.error(`Affiliate commission reversal failed for order ${order._id}:`, err.message);
  }
}

const checkoutService = require("../services/checkout.service");
const financialService = require("../services/financial.service");

const sendError = (res, error, fallback = "Something went wrong. Please try again.") => {
  if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
  console.error(error);
  return res.status(500).json({ message: fallback });
};

const deliveryFromBody = (body = {}) => ({
  shippingAddress: body.shippingAddress,
  recipient: body.recipient,
  deliveryMethod: body.deliveryMethod,
});

// @desc    Checkout the buyer's server-side cart & create a PENDING order
// @route   POST /api/orders/checkout
// @access  Private (Buyer/User)
exports.createCheckoutOrder = async (req, res) => {
  try {
    const cart = await Cart.findOne({ user: req.user.id });
    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ message: "Your cart is empty." });
    }

    const orderItems = [];
    let calculatedTotal = 0;

    // 2. Validate stock & prepare snapshot items
    for (const item of cart.items) {
      const product = await Product.findById(item.product._id);

      if (!product || product.status === "INACTIVE") {
        return res.status(400).json({
          message: `Product ${item.product.name || ""} is no longer available.`,
        });
      }

      if (product.stockQuantity < item.quantity) {
        return res.status(400).json({
          message: `Insufficient stock for ${product.name}. Available: ${product.stockQuantity}`,
        });
      }

      const activePrice = product.discountPrice || product.price;
      calculatedTotal += activePrice * item.quantity;

      orderItems.push({
        product: product._id,
        vendor: product.vendor,
        name: product.name,
        price: activePrice,
        quantity: item.quantity,
      });
    }

    // 2b. Last-click affiliate attribution, resolved from server-side records.
    const attributions = await affiliateAttribution.resolveAttributions({
      visitorId: req.body.visitorId,
      buyerId: req.user.id,
      productIds: orderItems.map((i) => i.product),
    });
    orderItems.forEach((i) => affiliateAttribution.applyAttribution(i, attributions.get(String(i.product))));

    // 3. Create the Order document
    const order = await Order.create({
      user: req.user.id,
      orderNumber: generateOrderNumber(),
      items: orderItems,
      shippingAddress,
      totalAmount: calculatedTotal,
      paymentMethod,
    });

    cart.items = [];
    cart.totalAmount = 0;
    await cart.save();

    socketService.emitOrderCreated(order);
    return res.status(201).json({ message: "Order placed successfully", order });
  } catch (error) {
    return sendError(res, error, "We could not place your order. Please try again.");
  }
};

// @desc    Direct checkout ("Buy now") with items in the request body
// @route   POST /api/orders/direct-checkout
// @access  Private (Buyer/User)
exports.directCheckout = async (req, res) => {
  try {
    const { items, shippingAddress, paymentMethod = "MOMO" } = req.body;

    if (!shippingAddress || !shippingAddress.street || !shippingAddress.city) {
      return res.status(400).json({ message: "Complete shipping address is required." });
    }

    if (!items || !items.length) {
      return res.status(400).json({ message: "At least one item is required." });
    }

    const orderItems = [];
    const productsToDecrement = [];
    const reservedQuantities = new Map();
    let calculatedTotal = 0;

    for (const item of items) {
      if (!item.productId || !mongoose.isValidObjectId(item.productId)) {
        return res.status(400).json({ message: "Every checkout item must reference a valid product." });
      }
      const product = await Product.findById(item.productId);
      if (!product || ["INACTIVE", "OUT_OF_STOCK"].includes(product.status)) {
        return res.status(400).json({ message: "A product in your cart is no longer available." });
      }
      const qty = Number(item.qty || item.quantity);
      if (!Number.isInteger(qty) || qty < 1) {
        return res.status(400).json({ message: "Product quantity must be a positive whole number." });
      }
      const productKey = product._id.toString();
      const reservedQty = (reservedQuantities.get(productKey) || 0) + qty;
      if (product.stockQuantity < reservedQty) {
        return res.status(400).json({
          message: `Insufficient stock for ${product.name}. Available: ${product.stockQuantity}`,
        });
      }
      reservedQuantities.set(productKey, reservedQty);
      const resolvedPrice = product.discountPrice || product.price;
      calculatedTotal += resolvedPrice * qty;
      const resolvedProduct = product._id;
      const resolvedVendor = product.vendor || null;
      const resolvedName = product.name;
      const resolvedImage = product.media?.mainImage || "";

      productsToDecrement.push({ product, qty });

      orderItems.push({
        product: resolvedProduct,
        vendor: resolvedVendor,
        name: resolvedName,
        price: resolvedPrice,
        quantity: qty,
        image: resolvedImage,
      });
    }

    const attributions = await affiliateAttribution.resolveAttributions({
      visitorId: req.body.visitorId,
      buyerId: req.user.id,
      productIds: orderItems.map((i) => i.product),
    });
    orderItems.forEach((i) => affiliateAttribution.applyAttribution(i, attributions.get(String(i.product))));

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const order = await Order.create({
      user: req.user.id,
      orderNumber: generateOrderNumber(),
      items: orderItems,
      shippingAddress,
      totalAmount: calculatedTotal,
      paymentMethod,
      paymentStatus: "PENDING",
      orderStatus: "PENDING",
      deliveryOtp: otp,
    });

    socketService.emitOrderCreated(order);
    return res.status(201).json({ message: "Order placed successfully", order });
  } catch (error) {
    return sendError(res, error, "We could not place your order. Please try again.");
  }
};

// @desc    Get logged-in user's orders
// @route   GET /api/orders/my-orders
// @access  Private (Buyer/User)
exports.getMyOrders = async (req, res) => {
  try {
    const orders = await Order.find({ user: req.user.id }).sort({
      createdAt: -1,
    });
    return res.status(200).json({ orders });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Get paid orders awaiting delivery confirmation
// @route   GET /api/orders/deliverable
exports.getDeliverable = async (req, res) => {
  try {
    const query = {
      paymentStatus: "PAID",
      orderStatus: { $nin: ["DELIVERED", "COMPLETED", "CANCELLED", "REFUNDED", "FAILED"] },
    };
    if (req.user.role === "vendor") query["items.vendor"] = req.user.id;

    const orders = await Order.find(query)
      .select("-deliveryOtp")
      .populate("user", "Fullname email phone")
      .populate("items.vendor", "Fullname companyName email")
      .sort({ createdAt: -1 });
    return res.status(200).json({ orders });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Get single order details
// @route   GET /api/orders/:id
// @access  Private
exports.getOrderById = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || id === "undefined" || !mongoose.isValidObjectId(id)) {
      return res.status(400).json({ message: "A valid order ID is required." });
    }

    const order = await Order.findById(id)
      .populate("user", "Fullname email")
      .populate("items.vendor", "Fullname companyName email");

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    // Verify ownership or vendor access
    const isBuyer = order.user && order.user._id.toString() === req.user.id.toString();
    const isVendor = order.items && order.items.some(
      (item) => item.vendor && item.vendor._id.toString() === req.user.id.toString(),
    );
    const isAdmin = req.user.role === "super_admin";

    if (!isBuyer && !isVendor && !isAdmin) {
      return res.status(403).json({ message: "Access denied." });
    }

    if (isBuyer || isAdmin) {
      return res.status(200).json({ order });
    }

    // A vendor only sees its own lines, and never the buyer's delivery code:
    // the code is the buyer's proof of receipt and must stay with the buyer.
    const vendorView = typeof order.toJSON === "function" ? order.toJSON() : { ...order };
    delete vendorView.deliveryOtp;
    vendorView.items = vendorView.items.filter(
      (item) => item.vendor && String(item.vendor._id || item.vendor) === String(req.user.id),
    );
    return res.status(200).json({ order: vendorView });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Get orders containing vendor's products
// @route   GET /api/orders/vendor/orders
// @access  Private (Vendor)
exports.getVendorOrders = async (req, res) => {
  try {
    const vendorId = req.vendorId || req.targetVendorId || req.user.id;
    const vendorIds = [req.user.id.toString()];
    if (vendorId) vendorIds.push(vendorId.toString());

    const orders = await Order.find({ "items.vendor": { $in: [req.user.id, vendorId] } })
      .populate("user", "Fullname email")
      .sort({ createdAt: -1 });

    // Filter order items to only include products belonging to this vendor
    const filteredOrders = orders.map((order) => {
      const vendorItems = order.items.filter(
        (item) => item.vendor && vendorIds.includes(item.vendor.toString()),
      );

      return {
        _id: order._id,
        orderNumber: order.orderNumber,
        user: order.user,
        shippingAddress: order.shippingAddress,
        paymentStatus: order.paymentStatus,
        orderStatus: order.orderStatus,
        createdAt: order.createdAt,
        items: vendorItems,
        vendorSubtotal: vendorItems.reduce(
          (sum, item) => sum + item.price * item.quantity,
          0,
        ),
      };
    });

    return res.status(200).json({ orders: filteredOrders });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Update vendor-specific order status / item status
// @route   PATCH /api/orders/vendor/:id/status
// @access  Private (Vendor)
exports.updateVendorOrderStatus = async (req, res) => {
  try {
    const { orderId, status, paymentStatus } = req.body;
    const allowedOrderStatuses = [
      "PENDING",
      "CONFIRMED",
      "PROCESSING",
      "READY_FOR_SHIPMENT",
      "SHIPPED",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
      "COMPLETED",
      "CANCELLED",
      "RETURNED",
      "REFUNDED",
      "FAILED",
    ];

    const allowedPaymentStatuses = [
      "PENDING",
      "CONFIRMED",
      "PAID",
      "FAILED",
      "REFUNDED",
    ];

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found." });
    }

    // Verify vendor ownership
    const vendorId = req.vendorId || req.targetVendorId || req.user.id;
    const vendorIds = [req.user.id.toString()];
    if (vendorId) vendorIds.push(vendorId.toString());

    const hasVendorItems = order.items && order.items.some(
      (item) => item.vendor && vendorIds.includes(item.vendor.toString()),
    );

    if (!hasVendorItems && req.user.role !== "super_admin") {
      return res
        .status(403)
        .json({
          message: "Access denied: You do not own items in this order.",
        });
    }

    if (status) {
      if (!allowedOrderStatuses.includes(status)) {
        return res
          .status(400)
          .json({ message: `Invalid order status: ${status}` });
      }
      order.orderStatus = status;
      if (status === "DELIVERED") {
        order.isDelivered = true;
        order.deliveredAt = new Date();
      }
    }

    if (paymentStatus) {
      if (!allowedPaymentStatuses.includes(paymentStatus)) {
        return res
          .status(400)
          .json({ message: `Invalid payment status: ${paymentStatus}` });
      }
      order.paymentStatus = paymentStatus;
    }

    await order.save();
    await reverseCommissionIfVoided(order);

    // Notify connected buyers, vendors, and admins in real-time
    socketService.emitOrderStatusUpdate(order);

    // Trigger payout release if order is marked as DELIVERED
    if (status === "DELIVERED") {
      await payoutController.releaseOrderEarnings(order._id, vendorId);
    }

    return res.status(200).json({
      message: "Order updated successfully",
      order,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Update Order Status (e.g., PENDING -> PROCESSING -> SHIPPED -> DELIVERED)
// @route   PATCH /api/orders/:id/status
// @access  Private (Vendor / Admin)
exports.updateOrderStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = [
      "PENDING",
      "CONFIRMED",
      "PROCESSING",
      "READY_FOR_SHIPMENT",
      "SHIPPED",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
      "COMPLETED",
      "CANCELLED",
    ];
    if (!status || !validStatuses.includes(status.toUpperCase())) {
      return res.status(400).json({ message: "Invalid order status provided." });
    }

    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ message: "Order not found." });
    }

    const updatedStatus = status.toUpperCase();

    // Prevent re-processing already delivered orders
    if (order.orderStatus === "DELIVERED" && updatedStatus !== "COMPLETED") {
      return res.status(400).json({ message: "Order has already been marked as DELIVERED." });
    }

    order.orderStatus = updatedStatus;
    
    if (updatedStatus === "DELIVERED") {
      order.deliveredAt = new Date();
      order.isDelivered = true;
    }

    await order.save();
    await reverseCommissionIfVoided(order);

    // Real-time broadcast
    socketService.emitOrderStatusUpdate(order);

    // 🚀 EARNINGS RELEASE ENGINE
    // If status reaches DELIVERED, release pending earnings per vendor in the order
    if (updatedStatus === "DELIVERED") {
      // Find all unique vendors involved in this order
      const vendorIds = [
        ...new Set(
          (order.items || [])
            .filter((item) => item.vendor)
            .map((item) => item.vendor.toString())
        ),
      ];

      // Release earnings for each vendor asynchronously
      for (const vendorId of vendorIds) {
        await payoutController.releaseOrderEarnings(order._id, vendorId);
      }
    }

    return res.status(200).json({
      message: `Order status successfully updated to ${updatedStatus}.`,
      order,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};


// @desc    Confirm Order Delivery & Release Escrow Funds
// @route   PATCH /api/orders/:id/deliver
// @access  Private (Admin / Delivery Agent)
exports.confirmOrderDelivery = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { id } = req.params;
    const { deliveryOtp } = req.body; // Proof of delivery check

    if (!id || id === "undefined" || !mongoose.isValidObjectId(id)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: "A valid order ID is required." });
    }

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ message: "Order not found." });
    }

    if (order.orderStatus === "DELIVERED") {
      await session.abortTransaction();
      return res.status(400).json({ message: "Order is already marked as DELIVERED." });
    }

    if (["CANCELLED", "REFUNDED", "RETURNED", "FAILED"].includes(order.orderStatus)) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ message: `A ${order.orderStatus.toLowerCase()} order cannot be delivered.` });
    }

    // 1. Verify Delivery OTP if enforced
    if (order.deliveryOtp && order.deliveryOtp !== deliveryOtp) {
      await session.abortTransaction();
      return res.status(400).json({ message: "Invalid delivery verification code." });
    }

    // 2. Update Order Delivery Metadata
    order.orderStatus = "DELIVERED";
    order.isDelivered = true;
    order.deliveredAt = new Date();
    await order.save({ session });

    // 3. Extract unique vendor IDs involved in the order
    const vendorIds = [
      ...new Set(
        order.items
          .filter((item) => item.vendor)
          .map((item) => item.vendor.toString())
      ),
    ];

    // 4. Release Escrow Funds per Vendor Atomically
    for (const vendorId of vendorIds) {
      await releaseVendorEscrowFunds(order._id, vendorId, session);
    }

    // 5. Delivery confirmed: approve this order's pending affiliate commissions
    //    (same transaction, idempotent, skipped for unpaid/cancelled orders).
    await financialService.approveAffiliateCommissionsForOrder({ orderId: order._id, session });

    await session.commitTransaction();
    session.endSession();

    // Real-time broadcast
    socketService.emitOrderStatusUpdate(order);

    return res.status(200).json({
      message: "Order delivered successfully and funds released from escrow.",
      order,
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Get all orders across marketplace (Admin)
// @route   GET /api/orders
// @access  Private (Super Admin / Admin)
exports.getAllOrders = async (req, res) => {
  try {
    const orders = await Order.find()
      .populate("user", "Fullname email phone")
      .populate("items.vendor", "Fullname companyName email phone")
      .sort({ createdAt: -1 });

    return res.status(200).json({ orders });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

/*
 * Buyer-initiated cancellation.
 *  - An unpaid order can be cancelled at any time before payment.
 *  - A paid order can be cancelled within 30 minutes of payment, before the
 *    seller starts shipping. Held escrow is reversed and a refund is recorded.
 * Stock is always returned.
 */
// @route   POST /api/orders/:id/cancel
// @access  Private (Buyer / Super Admin)
const BUYER_CANCEL_WINDOW_MS = 30 * 60 * 1000;
const CANCELLABLE_STATUSES = ["PENDING", "CONFIRMED", "PROCESSING"];

exports.cancelOrderByBuyer = async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) {
    return res.status(400).json({ message: "A valid order ID is required." });
  }

  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ message: "Order not found." });
    }
    if (String(order.user) !== String(req.user.id) && req.user.role !== "super_admin") {
      await session.abortTransaction();
      return res.status(403).json({ message: "Access denied." });
    }
    if (!CANCELLABLE_STATUSES.includes(order.orderStatus)) {
      await session.abortTransaction();
      return res.status(400).json({ message: "This order is already being delivered or closed and cannot be cancelled." });
    }

    if (!["PENDING", "PAID"].includes(order.paymentStatus)) {
      await session.abortTransaction();
      return res.status(400).json({ message: "This order is under review and cannot be cancelled right now." });
    }

    const isPaid = order.paymentStatus === "PAID";
    if (isPaid) {
      const paidAt = new Date(order.paidAt || order.updatedAt || order.createdAt).getTime();
      if (!Number.isFinite(paidAt) || Date.now() - paidAt >= BUYER_CANCEL_WINDOW_MS) {
        await session.abortTransaction();
        return res.status(400).json({ message: "The 30-minute cancellation period has ended. Use Report a problem instead." });
      }
      await financialService.refundHeldEscrowForOrder({ orderId: order._id, session });
      await Payment.updateMany({ parentOrder: order._id, status: "SUCCESS" }, { status: "REFUNDED" }, { session });
      order.paymentStatus = "REFUNDED";
      order.cancellationReason = "Buyer cancelled within 30 minutes of payment";
    } else {
      await Payment.updateMany({ parentOrder: order._id, status: "PENDING" }, { status: "CANCELLED" }, { session });
      order.cancellationReason = "Buyer cancelled before payment";
    }
    order.orderStatus = "CANCELLED";
    await order.save({ session });

    await session.commitTransaction();

    // Full refund: claw back any affiliate commission earned on this order.
    await affiliateAttribution.reverseOrderCommission({
      orderId: order._id,
      key: `order-cancel:${order._id}`,
      reason: "Order cancelled and refunded",
    });

    // Restore stock for each product that was snapshot into this order
    for (const item of order.items || []) {
      if (!item.product) continue;
      const product = await Product.findById(item.product);
      if (product) {
        product.stockQuantity = Math.max(0, (product.stockQuantity || 0) + (item.quantity || 0));
        if (product.status === "OUT_OF_STOCK" && product.stockQuantity > 0) product.status = "ACTIVE";
        await product.save();
      }
    }

    socketService.emitOrderStatusUpdate(order);

    return res.status(200).json({
      message: isPaid
        ? "Order cancelled. A full refund has been recorded and MVEC will return the payment."
        : "Order cancelled.",
      order,
    });
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    return sendError(res, error, "We could not cancel this order. Please try again.");
  } finally {
    session.endSession();
  }
};

/**
 * Internal Escrow Release Helper
 * Handles double-entry ledger transitions & wallet updates atomically
 */
async function releaseVendorEscrowFunds(orderId, vendorId, session) {
  // Find held settlement record for this order & vendor
  // One settlement exists per order item, so a vendor can have several.
  const settlements = await Settlement.find({
    order: orderId,
    vendor: vendorId,
    status: "HELD",
  }).session(session);

  for (const settlement of settlements) {
    await releaseSettlement(settlement, orderId, vendorId, session);
  }
}

async function releaseSettlement(settlement, orderId, vendorId, session) {
  const releaseAmount = settlement.netAmount; // Amount after platform commission

  // 1. Update Settlement State
  settlement.status = "RELEASED";
  settlement.releasedAt = new Date();
  await settlement.save({ session });

  // 2. Update Vendor Wallet Balances (pendingBalance -> availableBalance)
  const wallet = await VendorWallet.findOne({ vendor: vendorId }).session(session);
  if (wallet) {
    wallet.pendingBalance = Math.max(0, wallet.pendingBalance - releaseAmount);
    wallet.availableBalance += releaseAmount;
    wallet.totalEarned += releaseAmount;
    await wallet.save({ session });
  }

  // 3. Record Double-Entry Financial Ledger Entry
  await LedgerEntry.create(
    [
      {
        referenceType: "ESCROW_RELEASE",
        referenceId: orderId,
        vendor: vendorId,
        debitAccount: "ESCROW_HOLDING_ACCOUNT",
        creditAccount: "VENDOR_PAYABLE_ACCOUNT",
        amount: releaseAmount,
        currency: "RWF",
        description: `Escrow payout released for order #${orderId}`,
      },
    ],
    { session }
  );
}
