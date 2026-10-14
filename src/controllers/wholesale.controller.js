const wholesaleService = require("../services/wholesale.service");
const WholesaleOrder = require("../models/WholesaleOrder");

exports.listMyWholesaleOrders = async (req, res) => {
  try {
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 100);
    const owner = req.user.role === "supplier" ? "supplier" : "vendor";
    const filter = { [owner]: req.user.id };
    const [orders, total] = await Promise.all([
      WholesaleOrder.find(filter)
        .populate("vendor", "Fullname companyName email")
        .populate("supplier", "Fullname companyName email")
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      WholesaleOrder.countDocuments(filter),
    ]);
    return res.status(200).json({
      success: true,
      orders,
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

exports.createWholesaleOrder = async (req, res) => {
  try {
    const { supplierId, items } = req.body;
    const vendorId = req.user.id; // Extracted from Auth JWT

    const order = await wholesaleService.createWholesaleOrder({
      vendorId,
      supplierId,
      items,
    });

    return res.status(201).json({
      success: true,
      message: "Wholesale supply order created successfully.",
      data: order,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

exports.holdEscrow = async (req, res) => {
  try {
    const { orderId } = req.params;
    const updatedOrder = await wholesaleService.holdWholesaleEscrow(orderId);

    return res.status(200).json({
      success: true,
      message: "Funds locked in escrow successfully.",
      data: updatedOrder,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

exports.confirmReceipt = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { otp } = req.body;
    const order = await WholesaleOrder.findOne({
      _id: orderId,
      vendor: req.user.id,
    });
    if (!order) {
      return res.status(404).json({ success: false, message: "Wholesale order not found." });
    }

    const result = await wholesaleService.confirmReceiptAndRelease(orderId, otp);

    return res.status(200).json({
      success: true,
      message: "Wholesale order confirmed and escrow funds released to supplier.",
      data: result,
    });
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

exports.markShipped = async (req, res) => {
  try {
    const order = await wholesaleService.markWholesaleOrderShipped(
      req.params.orderId,
      req.user.id,
    );
    return res.status(200).json({ success: true, data: order });
  } catch (error) {
    const status = error.message === "Wholesale order not found." ? 404 : 400;
    return res.status(status).json({ success: false, message: error.message });
  }
};
// @desc    The vendor pays a wholesale order (mobile money or card). The order
//          is locked in escrow only when the payment provider confirms it.
// @route   POST /api/wholesale/orders/:orderId/pay   { method: "momo" | "card", phoneNumber? }
// @access  Private (the vendor who placed the order)
exports.payWholesaleOrder = async (req, res) => {
  const payments = require("./payment.controller");
  const paymentService = require("../services/payment.service");
  const flutterwave = require("../services/flutterwave.service");
  const Payment = require("../models/Payment");
  try {
    const order = await WholesaleOrder.findOne({ _id: req.params.orderId, vendor: req.user.id });
    if (!order) return res.status(404).json({ message: "Wholesale order not found." });
    if (order.status !== "PENDING_PAYMENT") return res.status(409).json({ message: "This order is already paid." });
    const amount = Math.round(Number(order.totalAmount));
    const reference = `WHS-${order._id}-${Date.now()}`;
    const method = String(req.body.method || "momo").toLowerCase();

    if (method === "momo") {
      const result = await payments.initiateStandalonePayment({
        amount, phoneNumber: req.body.phoneNumber, userId: req.user.id,
        gatewayService: payments.paypackGateway, purpose: "WHOLESALE", reference,
      });
      return res.status(200).json(result);
    }
    if (method !== "card") return res.status(400).json({ message: "Choose mobile money or card." });
    if (flutterwave.isSandbox() && process.env.NODE_ENV === "production") {
      return res.status(503).json({ message: "Card payments are temporarily unavailable. Please pay with mobile money." });
    }
    const payment = await Payment.create({
      user: req.user.id, transactionReference: reference, method: "CARD", gateway: "FLUTTERWAVE", provider: "CARD",
      amount, currency: "RWF", status: "PENDING", purpose: "WHOLESALE",
    });
    if (flutterwave.isSandbox()) {
      const result = await flutterwave.verifyByReference(reference);
      await paymentService.settleGatewayPayment({ payment, provider: "FLUTTERWAVE", status: result.status, amount, payload: result.raw, externalTransactionId: result.id });
      return res.status(200).json({ message: "Card payment confirmed (test mode).", paymentId: payment._id, status: "SUCCESS", checkoutUrl: null });
    }
    const frontend = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
    const checkout = await flutterwave.createCheckout({
      txRef: reference, amount,
      customer: { email: req.user.email, phone: req.user.phone, name: req.user.Fullname },
      redirectUrl: `${frontend}/vendor/purchases?paymentId=${payment._id}`,
      description: `MVEC wholesale order ${order.orderNumber}`,
    });
    return res.status(200).json({ message: "Opening the secure card page…", paymentId: payment._id, status: "PENDING", checkoutUrl: checkout.link });
  } catch (error) {
    if (error.statusCode && error.statusCode < 500) return res.status(error.statusCode).json({ message: error.message });
    console.error("Wholesale payment failed:", error);
    return res.status(502).json({ message: "We could not start the payment. You have not been charged; please try again." });
  }
};
