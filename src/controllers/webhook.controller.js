const Payment = require("../models/Payment");
const paymentService = require("../services/payment.service");
const paypackService = require("../services/paypack.service");
const { checkWebhook, hmacMatches } = require("../utils/webhookAuth");


// @desc    MTN MoMo Payment Webhook Receiver
// @route   POST /api/webhooks/momo
// @access  Public (Provider Verified)
exports.handleMomoWebhook = async (req, res) => {
  try {
    const failure = checkWebhook({
      provider: "MoMo",
      secret: process.env.MOMO_WEBHOOK_SECRET,
      signature: req.headers["x-momo-signature"],
      verify: (sig, secret) => hmacMatches(req, sig, secret),
    });
    if (failure) return res.status(failure.status).json({ message: failure.message });

    // MoMo callback payload: { status, externalId, financialTransactionId, amount, fee }
    const { financialTransactionId, externalId, amount, fee } = req.body;
    const gatewayFee = Number(fee) || 0;

    // MoMo uses "SUCCESSFUL" for completed transactions
    if (req.body.status !== "SUCCESSFUL") {
      if (financialTransactionId || externalId) {
        await paymentService.recordIgnoredWebhook({
          provider: "MTN_MOMO",
          externalTransactionId: financialTransactionId || externalId,
          amount: Number(amount || 0),
          payload: req.body,
        });
      }
      return res.status(200).json({
        success: true,
        message: "Transaction status not successful. Ignored.",
      });
    }

    const externalTransactionId = financialTransactionId || externalId;

    // Resolve the internal order through the persisted Payment record.
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
      return res
        .status(404)
        .json({ message: "Unable to resolve order for webhook callback." });
    }

    const result = await paymentService.processPaymentWebhook({
      provider: "MTN_MOMO",
      externalTransactionId,
      orderId,
      amount: Number(amount),
      payload: req.body,
      gatewayFee,
    });

    return res
      .status(200)
      .json({
        success: true,
        message: "MoMo webhook processed successfully.",
        result,
      });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Airtel Money Payment Webhook Receiver
// @route   POST /api/webhooks/airtel
// @access  Public (Provider Verified)
exports.handleAirtelWebhook = async (req, res) => {
  try {
    // The signature was checked by verifyAirtelSignature before this runs.
    const { transaction, status } = req.body;

    // 3. Robust Extraction across V1 / V2 Webhook Schemas
    const externalTransactionId =
      transaction?.id || transaction?.airtel_money_id;
    const reference = transaction?.reference || req.body?.reference;
    const amount = Number(transaction?.amount);
    const gatewayFee = Number(transaction?.fee) || 0;

    // Standardize status extraction
    const statusCode = String(
      transaction?.status_code || transaction?.code || status?.code || "",
    ).toUpperCase();

    const isSuccess = ["TS", "200", "2000", "SUCCESS", "DP0001"].includes(
      statusCode,
    );

    // If transaction failed or pending, acknowledge webhook but do not fullfill order
    if (!isSuccess) {
      console.log(
        `[Airtel Webhook] Payment not successful for ref: ${reference}. Code: ${statusCode}`,
      );
      return res
        .status(200)
        .json({
          success: true,
          message:
            "Airtel transaction non-successful status received and recorded.",
        });
    }

    // 4. Resolve Internal Order / Payment Record
    let orderId = null;

    if (reference) {
      const payment = await Payment.findOne({
        $or: [
          { transactionReference: reference },
          { gatewayReference: reference },
          { _id: reference.match(/^[0-9a-f]{24}$/i) ? reference : null },
        ].filter(Boolean),
      });

      if (payment) {
        orderId = payment.parentOrder || payment._id;
      }
    }

    // Fallback: direct MongoDB ObjectId match if reference is the order ID directly
    if (!orderId && reference && /^[0-9a-f]{24}$/i.test(reference)) {
      orderId = reference;
    }

    if (!orderId) {
      console.error(
        `[Airtel Webhook] Unresolved order reference: ${reference}`,
      );
      return res
        .status(404)
        .json({ message: "Unable to resolve order for webhook callback." });
    }

    // 5. Process Successful Payment Execution
    const result = await paymentService.processPaymentWebhook({
      provider: "AIRTEL_MONEY",
      externalTransactionId,
      orderId,
      amount,
      payload: req.body,
      gatewayFee,
    });

    // Always respond with 200 OK so Airtel stops retrying the webhook
    return res
      .status(200)
      .json({
        success: true,
        message: "Airtel webhook processed successfully.",
        result,
      });
  } catch (error) {
    console.error("[Airtel Webhook Error]:", error);
    // Respond with 500 so gateway knows to retry later
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Paypack Payment Webhook Receiver
// @route   POST /api/webhooks/paypack
// @access  Public (Provider Verified via X-Paypack-Signature)
exports.handlePaypackWebhook = async (req, res) => {
  try {
    const failure = checkWebhook({
      provider: "Paypack",
      secret: process.env.PAYPACK_WEBHOOK_SECRET,
      signature: req.headers["x-paypack-signature"],
      verify: (sig, secret) => paypackService.verifyWebhookSignature(req.rawBody, sig, secret),
    });
    if (failure) return res.status(failure.status).json({ message: failure.message });

    // Payload: { event_id, event_kind, created_at, data: { ref, kind, amount, fee, status, ... } }
    const { event_kind: eventKind, data = {} } = req.body;

    // Money MVEC sent out (refunds, affiliate withdrawals).
    if (eventKind === "transaction:processed" && data.kind === "CASHOUT") {
      await require("../services/disbursement.service").handleCallback({
        ref: data.ref,
        status: paypackService.normalizeStatus(data.status),
      });
      return res.status(200).json({ success: true, message: "Transfer update recorded." });
    }

    // Only a processed CASHIN carries a final status; ignore everything else.
    if (eventKind !== "transaction:processed" || data.kind !== "CASHIN") {
      return res.status(200).json({ success: true, message: "Event ignored." });
    }

    const payment = await Payment.findOne({ gatewayReference: data.ref });
    if (!payment) {
      return res
        .status(404)
        .json({ message: "Unable to resolve payment for webhook callback." });
    }

    const result = await paymentService.settlePaypackPayment({
      payment,
      status: paypackService.normalizeStatus(data.status),
      amount: Number(data.amount),
      fee: Number(data.fee) || 0,
      payload: req.body,
    });

    return res.status(200).json({
      success: true,
      message: "Paypack webhook processed successfully.",
      result,
    });
  } catch (error) {
    console.error("[Paypack Webhook Error]:", error);
    // Respond with 500 so Paypack retries later
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Flutterwave card payment webhook (charge.completed)
// @route   POST /api/webhooks/flutterwave
// @access  Public (verified with the dashboard secret hash, then re-checked with Flutterwave's API)
exports.handleFlutterwaveWebhook = async (req, res) => {
  const flutterwaveService = require("../services/flutterwave.service");
  try {
    if (!flutterwaveService.verifyWebhook(req.headers)) {
      return res.status(401).json({ message: "Invalid webhook signature" });
    }
    const txRef = req.body?.data?.tx_ref;
    if (!txRef) return res.status(200).json({ success: true, message: "Ignored: no transaction reference." });

    const payment = await Payment.findOne({ transactionReference: txRef, gateway: "FLUTTERWAVE" });
    if (!payment) return res.status(200).json({ success: true, message: "Ignored: unknown payment." });
    if (payment.status !== "PENDING") return res.status(200).json({ success: true, message: "Already processed." });

    // Never trust the webhook body: ask Flutterwave for the real status and amount.
    const result = await flutterwaveService.verifyByReference(txRef);
    if (result.status === "SUCCESSFUL" && result.currency && result.currency !== "RWF") {
      return res.status(200).json({ success: false, message: "Unexpected currency; payment left for review." });
    }
    const outcome = await paymentService.settleGatewayPayment({
      payment,
      provider: "FLUTTERWAVE",
      status: result.status,
      amount: result.amount ?? payment.amount,
      fee: result.fee || 0,
      payload: result.raw || {},
      externalTransactionId: result.id,
    });
    return res.status(200).json({ success: true, result: outcome?.status || result.status });
  } catch (error) {
    console.error("Flutterwave webhook failed:", error);
    // 500 makes Flutterwave retry later.
    return res.status(500).json({ message: "Webhook processing failed; it will be retried." });
  }
};

// @desc    K-Pay payment callback. K-Pay does not sign callbacks, so the body is
//          never trusted: the status is re-checked with K-Pay before anything changes.
// @route   POST /api/webhooks/kpay   { tid, refid, statusid, ... }
// @access  Public
exports.handleKpayWebhook = async (req, res) => {
  const kpayService = require("../services/kpay.service");
  const { tid = "", refid = "" } = req.body || {};
  const ack = () => res.status(200).json({ tid, refid, reply: "OK" });
  try {
    if (!refid) return ack();
    const payment = await Payment.findOne({ transactionReference: String(refid), gateway: "KPAY" });
    if (!payment || payment.status !== "PENDING") return ack();
    const result = await kpayService.checkStatus(String(refid));
    await paymentService.settleGatewayPayment({
      payment, provider: "KPAY", status: result.status, amount: payment.amount,
      payload: result.raw || {}, externalTransactionId: result.tid || String(tid) || payment.gatewayReference,
    });
    return ack();
  } catch (error) {
    console.error("K-Pay webhook failed:", error);
    return res.status(500).json({ tid, refid, reply: "RETRY" });
  }
};
