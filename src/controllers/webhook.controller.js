const crypto = require("crypto");
const paymentService = require("../services/payment.service");

/**
 * HMAC Validation Helper
 */
function verifyWebhookSignature(payload, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const hmac = crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signatureHeader));
}

// @desc    MTN MoMo Payment Webhook Receiver
// @route   POST /api/webhooks/momo
// @access  Public (Provider Verified)
exports.handleMomoWebhook = async (req, res) => {
  try {
    const signature = req.headers["x-momo-signature"];
    const isSandbox = process.env.NODE_ENV !== "production";

    if (!isSandbox && !verifyWebhookSignature(req.body, signature, process.env.MOMO_WEBHOOK_SECRET)) {
      return res.status(401).json({ message: "Invalid webhook signature" });
    }

    const { financialTransactionId, externalId, amount, status } = req.body;

    if (status !== "SUCCESSFUL") {
      return res.status(200).json({ message: "Transaction status not SUCCESSFUL. Ignored." });
    }

    const result = await paymentService.processPaymentWebhook({
      provider: "MTN_MOMO",
      externalTransactionId: financialTransactionId || externalId,
      orderId: externalId,
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
    const isSandbox = process.env.NODE_ENV !== "production";

    if (!isSandbox && !verifyWebhookSignature(req.body, signature, process.env.AIRTEL_WEBHOOK_SECRET)) {
      return res.status(401).json({ message: "Invalid webhook signature" });
    }

    const { transaction } = req.body;
    // Airtel payload format
    const externalTransactionId = transaction?.id;
    const orderId = transaction?.reference;
    const amount = Number(transaction?.amount);
    const statusCode = transaction?.status_code;

    if (statusCode !== "TS" && statusCode !== "200") { // TS = Transaction Success
      return res.status(200).json({ message: "Airtel transaction not successful. Ignored." });
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