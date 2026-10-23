// Wholesale orders: vendors buy from suppliers. All rules live in
// services/wholesale.service.js; this file resolves who is acting (owners or
// their team members) and turns results into responses.
const wholesaleService = require("../services/wholesale.service");
const WholesaleOrder = require("../models/WholesaleOrder");
const { supplierOwnerOf, vendorOwnerOf } = require("../utils/accountOwner.util");

const fail = (res, error) => res.status(error.statusCode || 400).json({ success: false, message: error.message });
// Which side the caller is on, and the owner account they act for.
async function side(req) {
  if (req.user.role === "supplier") {
    const owner = await supplierOwnerOf(req.user);
    if (!owner) throw Object.assign(new Error("Supplier profile not found. Complete onboarding first."), { statusCode: 403 });
    return { role: "supplier", userId: owner.userId };
  }
  return { role: "vendor", userId: vendorOwnerOf(req) };
}

exports.listMyWholesaleOrders = async (req, res) => {
  try {
    const me = await side(req);
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 50, 1), 100);
    const filter = { [me.role]: me.userId };
    if (req.query.status) filter.status = String(req.query.status).toUpperCase();
    const [orders, total] = await Promise.all([
      WholesaleOrder.find(filter)
        .populate("vendor", "Fullname companyName email phone")
        .populate("supplier", "Fullname companyName email phone")
        .populate("store", "storeName isPrimary")
        .sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit),
      WholesaleOrder.countDocuments(filter),
    ]);
    return res.status(200).json({ success: true, orders, meta: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (error) {
    return fail(res, error);
  }
};

exports.createWholesaleOrder = async (req, res) => {
  try {
    const order = await wholesaleService.createWholesaleOrder({ vendorId: vendorOwnerOf(req), supplierId: (req.body || {}).supplierId, items: (req.body || {}).items, storeId: (req.body || {}).storeId });
    return res.status(201).json({ success: true, message: "Order placed. Pay within 48 hours to keep the stock reserved.", data: order });
  } catch (error) {
    return fail(res, error);
  }
};

// Admin: mark an order paid that was paid outside MVEC (audited).
exports.holdEscrow = async (req, res) => {
  try {
    const order = await wholesaleService.holdWholesaleEscrow(req.params.orderId);
    return res.status(200).json({ success: true, message: "Marked as paid; the money is held for the supplier.", data: order });
  } catch (error) {
    return fail(res, error);
  }
};

exports.confirmReceipt = async (req, res) => {
  try {
    const result = await wholesaleService.confirmReceiptAndRelease(req.params.orderId, vendorOwnerOf(req));
    const units = (result.stocked || []).reduce((n, s) => n + s.quantity, 0);
    const message = units ? `Receipt confirmed. The supplier has been paid and ${units} unit${units === 1 ? " was" : "s were"} added to your inventory.` : "Receipt confirmed. The supplier has been paid.";
    return res.status(200).json({ success: true, message, data: result });
  } catch (error) {
    return fail(res, error);
  }
};

exports.markShipped = async (req, res) => {
  try {
    const me = await side(req);
    const order = await wholesaleService.markWholesaleOrderShipped(req.params.orderId, me.userId);
    return res.status(200).json({ success: true, message: "Marked as shipped. The vendor was notified.", data: order });
  } catch (error) {
    return fail(res, error);
  }
};

// Vendor or supplier cancels before shipping (paid orders are refunded).
exports.cancelOrder = async (req, res) => {
  try {
    const me = await side(req);
    const order = await wholesaleService.cancelOrder(req.params.orderId, me, (req.body || {}).reason);
    return res.status(200).json({ success: true, message: "Order cancelled.", data: order });
  } catch (error) {
    return fail(res, error);
  }
};

// Vendor reports a problem; the money stays held until MVEC decides.
exports.reportProblem = async (req, res) => {
  try {
    const order = await wholesaleService.openDispute(req.params.orderId, vendorOwnerOf(req), (req.body || {}).reason);
    return res.status(200).json({ success: true, message: "Problem reported. MVEC will review it; the payment stays on hold.", data: order });
  } catch (error) {
    return fail(res, error);
  }
};

// Admin: list wholesale orders (e.g. ?status=DISPUTED) and decide disputes.
exports.adminList = async (req, res) => {
  try {
    const filter = req.query.status ? { status: String(req.query.status).toUpperCase() } : {};
    const orders = await WholesaleOrder.find(filter)
      .populate("vendor", "Fullname companyName email phone").populate("supplier", "Fullname companyName email phone")
      .sort({ updatedAt: -1 }).limit(Math.min(Number(req.query.limit) || 50, 200));
    return res.json({ orders });
  } catch (error) {
    return fail(res, error);
  }
};

exports.adminRestock = async (req, res) => {
  try {
    const result = await wholesaleService.restockCompletedOrder(req.params.orderId);
    return res.json({ success: true, message: "The goods were added to the vendor's store.", data: result });
  } catch (error) {
    return fail(res, error);
  }
};

exports.adminResolve = async (req, res) => {
  try {
    const order = await wholesaleService.resolveDispute(req.params.orderId, String((req.body || {}).decision || "").toUpperCase(), String((req.body || {}).note || "").trim());
    return res.json({ success: true, message: String((req.body || {}).decision).toUpperCase() === "RELEASE" ? "The supplier was paid." : "The vendor is being refunded.", data: order });
  } catch (error) {
    return fail(res, error);
  }
};

// @desc    The vendor pays a wholesale order (mobile money or card). The order
//          is locked in escrow only when the payment provider confirms it.
// @route   POST /api/wholesale/orders/:orderId/pay   { method: "momo" | "card", phoneNumber? }
exports.payWholesaleOrder = async (req, res) => {
  const payments = require("./payment.controller");
  const paymentService = require("../services/payment.service");
  const flutterwave = require("../services/flutterwave.service");
  const Payment = require("../models/Payment");
  try {
    const order = await WholesaleOrder.findOne({ _id: req.params.orderId, vendor: vendorOwnerOf(req) });
    if (!order) return res.status(404).json({ message: "Wholesale order not found." });
    if (order.status !== "PENDING_PAYMENT") return res.status(409).json({ message: order.status === "CANCELLED" ? "This order expired or was cancelled." : "This order is already paid." });
    const amount = Math.round(Number(order.totalAmount));
    const reference = `WHS-${order._id}-${Date.now()}`;
    const method = String((req.body || {}).method || "momo").toLowerCase();

    if (method === "momo") {
      const result = await payments.initiateStandalonePayment({
        amount, phoneNumber: (req.body || {}).phoneNumber, userId: req.user.id,
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
