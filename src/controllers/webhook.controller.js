const crypto = require("crypto");
const Payment = require("../models/Payment");
const paymentService = require("../services/payment.service");

/**
 * HMAC Validation Helper
 */
function verifyWebhookSignature(payload, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const hmac = crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
  const a = Buffer.from(hmac);
  const b = Buffer.from(signatureHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// @desc    MTN MoMo Payment Webhook Receiver
// @route   POST /api/webhooks/momo
// @access  Public (Provider Verified)
exports.handleMomoWebhook = async (req, res) => {
  try {
    const signature = req.headers["x-momo-signature"];
    const isSandbox = process.env.NODE_ENV !== "production" || !process.env.MOMO_WEBHOOK_SECRET;

    if (!isSandbox && !verifyWebhookSignature(req.body, signature, process.env.MOMO_WEBHOOK_SECRET)) {
      return res.status(401).json({ message: "Invalid webhook signature" });
    }

    const { financialTransactionId, externalId, amount, status } = req.body;

    if (status !== "SUCCESSFUL") {
      // Persist an IGNORED log so the external id is never reprocessed/confused later.
      if (financialTransactionId) {
        await paymentService.recordIgnoredWebhook({
          provider: "MTN_MOMO",
          externalTransactionId: financialTransactionId,
          amount: Number(amount),
          payload: req.body,
        });
      }
      return res.status(200).json({ message: "Transaction status not SUCCESSFUL. Ignored." });
    }

    const externalTransactionId = financialTransactionId || externalId;

    // Resolve the internal order through the persisted Payment record. The
    // gateway returns `externalId` (our transactionReference or gatewayReference),
    // so we never trust an arbitrary order id from the callback payload.
    let orderId = null;
    if (externalTransactionId) {
      const payment = await Payment.findOne({
        $or: [
          { transactionReference: externalId },
          { gatewayReference: financialTransactionId || externalId },
          { gatewayReference: externalId },
        ],
      });
      if (payment) orderId = payment.parentOrder;
    }
    // Fallback: provider includes our internal order id as external reference.
    if (!orderId && externalId) {
      orderId = /^[0-9a-f]{24}$/i.test(externalId) ? externalId : null;
    }

    if (!orderId) {
      return res.status(404).json({ message: "Unable to resolve order for webhook callback." });
    }

    const result = await paymentService.processPaymentWebhook({
      provider: "MTN_MOMO",
      externalTransactionId,
      orderId,
      amount: Number(amount),
      payload: req.body,
    });

    return res.status(200).json({ success: true, message: "MoMo webhook processed successfully.", result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Airtel Money Payment Webhook Receiver
// @route   POST /api/webhooks/airtel
// @access  Public (Provider Verified)
exports.handleAirtelWebhook = async (req, res) => {
  try {
    const signature = req.headers["x-airtel-signature"];
    const isSandbox = process.env.NODE_ENV !== "production" || !process.env.AIRTEL_WEBHOOK_SECRET;

    if (!isSandbox && !verifyWebhookSignature(req.body, signature, process.env.AIRTEL_WEBHOOK_SECRET)) {
      return res.status(401).json({ message: "Invalid webhook signature" });
    }

    const { transaction } = req.body;
    // Airtel payload format
    const externalTransactionId = transaction?.id;
    const reference = transaction?.reference;
    const amount = Number(transaction?.amount);
    const statusCode = transaction?.status_code;

    if (statusCode !== "TS" && statusCode !== "200") { // TS = Transaction Success
      return res.status(200).json({ message: "Airtel transaction not successful. Ignored." });
    }

    // Resolve the internal order from the persisted Payment record.
    let orderId = null;
    if (reference) {
      const payment = await Payment.findOne({
        $or: [{ transactionReference: reference }, { gatewayReference: reference }],
      });
      if (payment) orderId = payment.parentOrder;
    }
    if (!orderId && reference && /^[0-9a-f]{24}$/i.test(reference)) {
      orderId = reference;
    }
    if (!orderId) {
      return res.status(404).json({ message: "Unable to resolve order for webhook callback." });
    }

    const result = await paymentService.processPaymentWebhook({
      provider: "AIRTEL_MONEY",
      externalTransactionId,
      orderId,
      amount,
      payload: req.body,
    });

    return res.status(200).json({ success: true, message: "Airtel webhook processed successfully.", result });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};