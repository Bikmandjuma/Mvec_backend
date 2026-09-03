const Order = require("../models/Order");
const Cart = require("../models/Cart");
const Product = require("../models/Product");
const Settlement = require("../models/Settlement");
const LedgerEntry = require("../models/LedgerEntry");
const VendorWallet = require("../models/VendorWallet");
const payoutController = require("./payout.controller");

// Helper function to generate unique order numbers
const generateOrderNumber = () => {
  return `ORD-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
};

// @desc    Checkout user cart & create order
// @route   POST /api/orders/checkout
// @access  Private (Buyer/User)
exports.createCheckoutOrder = async (req, res) => {
  try {
    const { shippingAddress, paymentMethod = "CARD" } = req.body;

    if (!shippingAddress || !shippingAddress.street || !shippingAddress.city) {
      return res
        .status(400)
        .json({ message: "Complete shipping address is required." });
    }

    // 1. Fetch user's active cart
    const cart = await Cart.findOne({ user: req.user.id }).populate(
      "items.product",
    );

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

    // 3. Create the Order document
    const order = await Order.create({
      user: req.user.id,
      orderNumber: generateOrderNumber(),
      items: orderItems,
      shippingAddress,
      totalAmount: calculatedTotal,
      paymentMethod,
    });

    // 4. Update stock levels for purchased items
    for (const item of cart.items) {
      const product = await Product.findById(item.product._id);
      product.stockQuantity -= item.quantity;

      if (product.stockQuantity <= 0) {
        product.stockQuantity = 0;
        product.status = "OUT_OF_STOCK";
      }
      await product.save();
    }

    // 5. Clear user cart
    cart.items = [];
    cart.totalAmount = 0;
    await cart.save();

    return res.status(201).json({
      message: "Order placed successfully",
      order,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
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

// @desc    Get single order details
// @route   GET /api/orders/:id
// @access  Private
exports.getOrderById = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id)
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

    return res.status(200).json({ order });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Get orders containing vendor's products
// @route   GET /api/orders/vendor/orders
// @access  Private (Vendor)
exports.getVendorOrders = async (req, res) => {
  try {
    const orders = await Order.find({ "items.vendor": req.user.id })
      .populate("user", "Fullname email")
      .sort({ createdAt: -1 });

    // Filter order items to only include products belonging to this vendor
    const filteredOrders = orders.map((order) => {
      const vendorItems = order.items.filter(
        (item) => item.vendor && item.vendor.toString() === req.user.id.toString(),
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
      "DELIVERED",
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
    const hasVendorItems = order.items && order.items.some(
      (item) => item.vendor && item.vendor.toString() === req.user.id.toString(),
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

    // Trigger payout release if order is marked as DELIVERED
    if (status === "DELIVERED") {
      await payoutController.releaseOrderEarnings(order._id, req.user.id);
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

    const validStatuses = ["PENDING", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED"];
    if (!status || !validStatuses.includes(status.toUpperCase())) {
      return res.status(400).json({ message: "Invalid order status provided." });
    }

    const order = await Order.findById(id);
    if (!order) {
      return res.status(404).json({ message: "Order not found." });
    }

    const updatedStatus = status.toUpperCase();

    // Prevent re-processing already delivered orders
    if (order.orderStatus === "DELIVERED") {
      return res.status(400).json({ message: "Order has already been marked as DELIVERED." });
    }

    order.orderStatus = updatedStatus;
    
    if (updatedStatus === "DELIVERED") {
      order.deliveredAt = new Date();
      order.isDelivered = true;
    }

    await order.save();

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

    const order = await Order.findById(id).session(session);
    if (!order) {
      await session.abortTransaction();
      return res.status(404).json({ message: "Order not found." });
    }

    if (order.orderStatus === "DELIVERED") {
      await session.abortTransaction();
      return res.status(400).json({ message: "Order is already marked as DELIVERED." });
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

    await session.commitTransaction();
    session.endSession();

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

/**
 * Internal Escrow Release Helper
 * Handles double-entry ledger transitions & wallet updates atomically
 */
async function releaseVendorEscrowFunds(orderId, vendorId, session) {
  // Find held settlement record for this order & vendor
  const settlement = await Settlement.findOne({
    order: orderId,
    vendor: vendorId,
    status: "HELD",
  }).session(session);

  if (!settlement) return; // Already released or non-existent

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