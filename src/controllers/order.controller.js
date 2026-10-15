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
const shippingService = require("../services/shipping.service");
const financialService = require("../services/financial.service");
const Dispute = require("../models/Dispute");
const AffiliateLink = require("../models/AffiliateLink");
const ConversionAudit = require("../models/ConversionAudit");
const promotionService = require("../services/promotion.service");
const { AFFILIATE_PERCENT } = require("../config/revenueSplit");

// Delivery fees are always computed server-side from seller shipping zones.
// Returns { shipping } or { error } when a seller doesn't deliver to the address.
const priceShipping = async (lines, shippingAddress, shippingMethod) => {
  const quote = await shippingService.quoteShipping({ lines, address: shippingAddress, method: shippingMethod });
  if (!quote.deliverable) {
    return { error: quote.groups.filter((g) => !g.deliverable).map((g) => g.message).join(" ") };
  }
  const { province, district } = quote.address;
  return {
    shipping: {
      shippingFee: quote.shippingFee,
      shippingMethod: quote.method,
      shippingBreakdown: quote.groups.map((g) => ({
        vendor: g.vendor, store: g.store, storeName: g.storeName, zone: g.zone, zoneName: g.zoneName,
        method: g.method, fee: g.fee, eta: g.eta,
      })),
      address: {
        ...shippingAddress,
        province: province || shippingAddress.province,
        district: district || shippingAddress.district || shippingAddress.city,
        state: province || shippingAddress.state || shippingAddress.province,
      },
    },
  };
};

// A referral code from an affiliate link the buyer followed (?ref=CODE).
// Self-referrals and inactive links are ignored rather than failing checkout.
async function affiliateReferral(code, buyerId) {
  if (!code) return null;
  const link = await AffiliateLink.findOne({ affiliateCode: String(code).trim(), isActive: true });
  if (!link || String(link.affiliateUser) === String(buyerId)) return null;
  return link;
}

// Coupon + affiliate fields for a new order. lines: [{ product, quantity, price }].
// Mutates items (line discounts) and shipping (free delivery). Throws on a bad coupon.
async function checkoutExtras(req, lines, items, shipping) {
  const extras = { fields: { discountAmount: 0 }, itemDiscount: 0, promotionId: null, link: null };
  if (req.body.couponCode) {
    const q = await promotionService.quote(req.body.couponCode, { lines, parcels: shipping.shippingBreakdown, userId: req.user.id });
    const applied = promotionService.applyToOrder(q, items, shipping);
    extras.fields.coupon = applied.coupon;
    extras.fields.discountAmount = applied.discountAmount;
    extras.itemDiscount = applied.itemDiscount;
    extras.promotionId = q.promotion._id;
  }
  extras.link = await affiliateReferral(req.body.affiliateCode, req.user.id);
  if (extras.link) {
    extras.fields.affiliateCode = extras.link.affiliateCode;
    extras.fields.affiliateUser = extras.link.affiliateUser;
  }
  return extras;
}

// Creates the order, counting the coupon use first and giving it back on failure.
async function createOrderWithExtras(data, extras) {
  if (extras.promotionId) await promotionService.redeem(extras.promotionId);
  let order;
  try {
    order = await Order.create({ ...data, ...extras.fields });
  } catch (err) {
    if (extras.promotionId) await promotionService.release({ coupon: { promotion: extras.promotionId } });
    throw err;
  }
  if (extras.link) {
    const value = order.subtotal - extras.itemDiscount;
    ConversionAudit.create({
      affiliateUser: extras.link.affiliateUser, link: extras.link._id, targetProduct: extras.link.targetProduct || null,
      order: order._id, referralCode: extras.link.affiliateCode, conversionValue: value,
      commissionEarned: Math.round((value * AFFILIATE_PERCENT) / 100), status: "PENDING",
    }).catch((e) => console.error("Could not record affiliate conversion:", e.message));
  }
  return order;
}
const sendCheckoutError = (res, error) => res.status(error.status || 500).json({ message: error.message });

// Helper function to generate unique order numbers
const generateOrderNumber = () => {
  return `ORD-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;
};

// @desc    Checkout user cart & create order
// @route   POST /api/orders/checkout
// @access  Private (Buyer/User)
exports.createCheckoutOrder = async (req, res) => {
  try {
    const { shippingAddress, paymentMethod = "CARD", shippingMethod = "STANDARD" } = req.body;

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
    const shippingLines = [];
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
      shippingLines.push({ product, quantity: item.quantity, price: activePrice });

      orderItems.push({
        product: product._id,
        vendor: product.vendor,
        name: product.name,
        price: activePrice,
        quantity: item.quantity,
      });
    }

    const priced = await priceShipping(shippingLines, shippingAddress, shippingMethod);
    if (priced.error) return res.status(400).json({ message: priced.error });
    const extras = await checkoutExtras(req, shippingLines, orderItems, priced.shipping);

    // 3. Create the Order document
    const order = await createOrderWithExtras({
      user: req.user.id,
      orderNumber: generateOrderNumber(),
      items: orderItems,
      shippingAddress: priced.shipping.address,
      subtotal: calculatedTotal,
      shippingFee: priced.shipping.shippingFee,
      shippingMethod: priced.shipping.shippingMethod,
      shippingBreakdown: priced.shipping.shippingBreakdown,
      totalAmount: calculatedTotal - extras.itemDiscount + priced.shipping.shippingFee,
      paymentMethod,
    }, extras);

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
    return sendCheckoutError(res, error);
  }
};

// @desc    Direct checkout — accepts items in request body (for frontend-driven orders)
// @route   POST /api/orders/direct-checkout
// @access  Private (Buyer/User)
exports.directCheckout = async (req, res) => {
  try {
    const { items, shippingAddress, paymentMethod = "MOMO", shippingMethod = "STANDARD" } = req.body;

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

      productsToDecrement.push({ product, qty, price: resolvedPrice });

      orderItems.push({
        product: resolvedProduct,
        vendor: resolvedVendor,
        name: resolvedName,
        price: resolvedPrice,
        quantity: qty,
        image: resolvedImage,
      });
    }

    const lines = productsToDecrement.map(({ product, qty, price }) => ({ product, quantity: qty, price }));
    const priced = await priceShipping(lines, shippingAddress, shippingMethod);
    if (priced.error) return res.status(400).json({ message: priced.error });
    const extras = await checkoutExtras(req, lines, orderItems, priced.shipping);

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const order = await createOrderWithExtras({
      user: req.user.id,
      orderNumber: generateOrderNumber(),
      items: orderItems,
      shippingAddress: priced.shipping.address,
      subtotal: calculatedTotal,
      shippingFee: priced.shipping.shippingFee,
      shippingMethod: priced.shipping.shippingMethod,
      shippingBreakdown: priced.shipping.shippingBreakdown,
      totalAmount: calculatedTotal - extras.itemDiscount + priced.shipping.shippingFee,
      paymentMethod,
      paymentStatus: "PENDING",
      orderStatus: "PENDING",
      deliveryOtp: otp,
    }, extras);

    for (const { product, qty } of productsToDecrement) {
      product.stockQuantity = Math.max(0, product.stockQuantity - qty);
      if (product.stockQuantity === 0) product.status = "OUT_OF_STOCK";
      await product.save();
    }

    // Notify connected clients in real-time
    socketService.emitOrderCreated(order);

    return res.status(201).json({ message: "Order placed successfully", order });
  } catch (error) {
    return sendCheckoutError(res, error);
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
        source: order.source || "ONLINE",
        customer: order.customer,
        paidOffline: order.paidOffline,
        paymentMethod: order.paymentMethod,
        shippingAddress: order.shippingAddress,
        paymentStatus: order.paymentStatus,
        orderStatus: order.orderStatus,
        createdAt: order.createdAt,
        items: vendorItems,
        vendorSubtotal: vendorItems.reduce(
          (sum, item) => sum + item.price * item.quantity - (item.discount || 0),
          0,
        ),
        vendorDiscount: vendorItems.reduce((sum, item) => sum + (item.discount || 0), 0),
        coupon: order.coupon?.code && String(order.coupon.vendor) === String(req.user.id) ? order.coupon : undefined,
        affiliateCode: order.affiliateCode || undefined,
        // Delivery fees for this seller's parcels (paid to the seller, no commission).
        vendorShippingFee: (order.shippingBreakdown || [])
          .filter((s) => s.vendor && vendorIds.includes(s.vendor.toString()))
          .reduce((sum, s) => sum + (s.fee || 0), 0),
        shippingMethod: order.shippingMethod,
      };
    });

    return res.status(200).json({ orders: filteredOrders });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ---------------------------------------------------------------------------
// Seller order flow (enforced server-side; super_admin keeps full control).
// DELIVERED on MVEC-paid orders is confirmed only with the buyer's delivery OTP
// (PATCH /orders/:id/deliver), because it releases escrow. Sellers may close
// orders whose payment they collect themselves (manual cash / offline orders).
// ---------------------------------------------------------------------------
const SELLER_FLOW = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["READY_FOR_SHIPMENT", "CANCELLED"],
  READY_FOR_SHIPMENT: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["OUT_FOR_DELIVERY"],
  OUT_FOR_DELIVERY: [],
};
const sellerCollectsPayment = (order) =>
  order.source === "MANUAL" && (order.paidOffline || order.paymentMethod === "CASH_ON_DELIVERY");

function sellerNextStatuses(order) {
  const next = [...(SELLER_FLOW[order.orderStatus] || [])];
  if (sellerCollectsPayment(order)) {
    const deliverFrom = order.shippingMethod === "PICKUP"
      ? ["CONFIRMED", "PROCESSING", "READY_FOR_SHIPMENT"]
      : ["READY_FOR_SHIPMENT", "SHIPPED", "OUT_FOR_DELIVERY"];
    if (deliverFrom.includes(order.orderStatus)) next.push("DELIVERED");
  }
  return [...new Set(next)];
}
exports.sellerNextStatuses = sellerNextStatuses;

// Seller cancellation: restock their items and, for orders paid through MVEC,
// refund the buyer by unwinding the held escrow.
async function cancelBySeller(order, vendorIds, reason) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const paidThroughMvec = order.paymentStatus === "PAID" && !order.paidOffline;
    order.orderStatus = "CANCELLED";
    order.cancellationReason = reason || "Cancelled by the seller";
    if (paidThroughMvec || order.paidOffline) order.paymentStatus = "REFUNDED";
    await order.save({ session });

    for (const item of order.items || []) {
      if (!item.product || !item.vendor || !vendorIds.includes(item.vendor.toString())) continue;
      const product = await Product.findOneAndUpdate(
        { _id: item.product },
        { $inc: { stockQuantity: Number(item.quantity) || 0 } },
        { new: true, session },
      );
      if (product && product.status === "OUT_OF_STOCK" && product.stockQuantity > 0) {
        await Product.updateOne({ _id: product._id }, { $set: { status: "ACTIVE" } }, { session });
      }
    }

    if (paidThroughMvec) {
      await Payment.updateMany({ parentOrder: order._id, status: "SUCCESS" }, { $set: { status: "REFUNDED" } }, { session });
      const held = await Settlement.find({ order: order._id, status: { $in: ["HELD", "ADMIN_HOLD"] } }).session(session);
      for (const settlement of held) {
        settlement.status = "REFUNDED";
        await settlement.save({ session });
        await VendorWallet.updateOne(
          { vendor: settlement.vendor },
          { $inc: { pendingBalance: -Number(settlement.netAmount || 0) } },
          { session },
        );
      }
      // Wallets never go negative.
      await VendorWallet.updateMany({ pendingBalance: { $lt: 0 } }, { $set: { pendingBalance: 0 } }, { session });
    }

    await session.commitTransaction();
    await promotionService.release(order);
    session.endSession();
    return { refunded: paidThroughMvec };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
}

// @desc    Update vendor-specific order status / item status
// @route   PATCH /api/orders/vendor/status   { orderId, status?, paymentStatus?, reason? }
// @access  Private (Vendor / Super Admin)
exports.updateVendorOrderStatus = async (req, res) => {
  try {
    const { orderId, status, paymentStatus, reason } = req.body;
    const allowedOrderStatuses = [
      "PENDING", "CONFIRMED", "PROCESSING", "READY_FOR_SHIPMENT", "SHIPPED", "OUT_FOR_DELIVERY",
      "DELIVERED", "COMPLETED", "CANCELLED", "RETURNED", "REFUNDED", "FAILED",
    ];
    const allowedPaymentStatuses = ["PENDING", "CONFIRMED", "PAID", "FAILED", "REFUNDED"];

    if (!mongoose.isValidObjectId(orderId)) {
      return res.status(400).json({ message: "A valid order ID is required." });
    }
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Order not found." });
    }

    // Verify vendor ownership
    const vendorId = req.vendorId || req.targetVendorId || req.user.id;
    const vendorIds = [req.user.id.toString()];
    if (vendorId) vendorIds.push(vendorId.toString());
    const isAdmin = req.user.role === "super_admin" && !(order.items || []).some((item) => item.vendor && vendorIds.includes(item.vendor.toString()));

    const hasVendorItems = order.items && order.items.some(
      (item) => item.vendor && vendorIds.includes(item.vendor.toString()),
    );
    if (!hasVendorItems && req.user.role !== "super_admin") {
      return res.status(403).json({ message: "Access denied: You do not own items in this order." });
    }

    if (status && !allowedOrderStatuses.includes(status)) {
      return res.status(400).json({ message: `Invalid order status: ${status}` });
    }
    if (paymentStatus && !allowedPaymentStatuses.includes(paymentStatus)) {
      return res.status(400).json({ message: `Invalid payment status: ${paymentStatus}` });
    }

    // ---- Sellers: only the next steps of the flow --------------------------
    if (!isAdmin) {
      if (status && status !== order.orderStatus && !sellerNextStatuses(order).includes(status)) {
        const hint = status === "DELIVERED"
          ? "Delivery is confirmed with the buyer's delivery code, which releases the payment."
          : `Allowed next: ${sellerNextStatuses(order).join(", ") || "none"}.`;
        return res.status(400).json({ message: `This order can't move from ${order.orderStatus} to ${status}. ${hint}` });
      }
      if (paymentStatus && paymentStatus !== order.paymentStatus) {
        const codCollected = paymentStatus === "PAID" && order.source === "MANUAL" && order.paymentMethod === "CASH_ON_DELIVERY";
        if (!codCollected) {
          return res.status(403).json({ message: "Payment status is set by MVEC payments. You can only record cash collected on your own cash-on-delivery orders." });
        }
      }
      if (status === "CANCELLED" && status !== order.orderStatus) {
        const otherSellers = (order.items || []).some((item) => item.vendor && !vendorIds.includes(item.vendor.toString()));
        if (otherSellers) {
          return res.status(409).json({ message: "This order includes items from other sellers. Contact MVEC support to cancel your part." });
        }
        const result = await cancelBySeller(order, vendorIds, reason);
        socketService.emitOrderStatusUpdate(order);
        return res.status(200).json({
          message: result.refunded ? "Order cancelled. The buyer's payment has been refunded and stock restored." : "Order cancelled and stock restored.",
          order,
        });
      }
    }

    if (status) {
      order.orderStatus = status;
      if (status === "DELIVERED") {
        order.isDelivered = true;
        order.deliveredAt = new Date();
        // Cash on delivery: the seller collected the money at hand-over.
        if (!isAdmin && order.paymentMethod === "CASH_ON_DELIVERY") order.paymentStatus = "PAID";
      }
    }
    if (paymentStatus) order.paymentStatus = paymentStatus;

    await order.save();

    // Notify connected buyers, vendors, and admins in real-time
    socketService.emitOrderStatusUpdate(order);

    // Trigger payout release if order is marked as DELIVERED
    if (status === "DELIVERED") {
      await payoutController.releaseOrderEarnings(order._id, vendorId);
    }

    return res.status(200).json({
      message: "Order updated successfully",
      order,
      nextStatuses: sellerNextStatuses(order),
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
    // Cash on delivery is collected at hand-over.
    if (order.paymentMethod === "CASH_ON_DELIVERY" && order.paymentStatus !== "PAID") order.paymentStatus = "PAID";
    await order.save({ session });

    // 3. Extract unique vendor IDs involved in the order
    const vendorIds = [
      ...new Set(
        order.items
          .filter((item) => item.vendor)
          .map((item) => item.vendor.toString())
      ),
    ];

    // 4. Release every held settlement (items + delivery fee) through the
    //    ledger. Disputed parts stay frozen (ADMIN_HOLD) for arbitration.
    const held = await Settlement.find({ order: order._id, status: "HELD" }).session(session);
    for (const settlement of held) {
      await financialService.releaseEscrowToVendor({ settlementId: settlement._id, session });
    }

    await session.commitTransaction();
    session.endSession();

    // 5. Seller balances shown on the Payouts page (skipped while a dispute is open).
    const disputed = await Dispute.find({ order: order._id, status: { $in: ["OPEN", "UNDER_REVIEW", "EVIDENCE_SUBMITTED"] } }).distinct("vendor");
    const frozen = new Set(disputed.map(String));
    for (const vendorId of vendorIds) {
      if (!frozen.has(String(vendorId))) await payoutController.releaseOrderEarnings(order._id, vendorId);
    }

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
 * Buyer-initiated cancellation with a 30-minute refund window.
 * Restores stock, marks the order/payment as cancelled/refunded and notifies
 * connected clients in real-time.
 */
// @desc    Buyer cancels own order within 30 minutes of payment
// @route   POST /api/orders/:id/cancel
// @access  Private (Buyer / Super Admin)
const BUYER_CANCEL_WINDOW_MS = 30 * 60 * 1000;

exports.cancelOrderByBuyer = async (req, res) => {
  try {
    const { id } = req.params;
    const order = await Order.findById(id);

    if (!order) {
      return res.status(404).json({ message: "Order not found." });
    }
    if (String(order.user) !== String(req.user.id) && req.user.role !== "super_admin") {
      return res.status(403).json({ message: "Access denied." });
    }
    if (order.paymentStatus !== "PAID" && order.paymentStatus !== "CONFIRMED") {
      return res.status(400).json({ message: "Only paid orders can be cancelled from this page." });
    }
    if (["CANCELLED", "REFUNDED", "COMPLETED", "DELIVERED", "RETURNED"].includes(order.orderStatus)) {
      return res.status(400).json({ message: "This order cannot be cancelled anymore." });
    }
    if (!["PENDING", "CONFIRMED", "PROCESSING"].includes(order.orderStatus)) {
      return res.status(400).json({ message: "This order is already being fulfilled and cannot be cancelled." });
    }

    // The cancellation deadline is fixed from order creation time.
    const payment = await Payment.findOne({ parentOrder: order._id, status: "SUCCESS" }).sort({ createdAt: -1 });
    const cancellationDeadline = new Date(order.createdAt).getTime() + BUYER_CANCEL_WINDOW_MS;
    if (!order.createdAt || !Number.isFinite(cancellationDeadline) || Date.now() >= cancellationDeadline) {
      return res.status(400).json({ message: "The 30-minute cancellation period has ended." });
    }

    order.orderStatus = "CANCELLED";
    order.paymentStatus = "REFUNDED";
    order.cancellationReason = "Buyer cancelled within 30 minutes of payment";
    await order.save();
    await promotionService.release(order);

    if (payment) {
      payment.status = "REFUNDED";
      await payment.save();
    }

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
      message: "Order cancelled successfully. A full refund has been recorded.",
      order,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};


