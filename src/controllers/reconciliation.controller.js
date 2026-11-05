const ProviderStatement = require("../models/ProviderStatement");
const PaymentWebhookLog = require("../models/PaymentWebhookLog");
const Payment = require("../models/Payment");

const MAX_ROWS = 5000;
// Statement providers the provider_statements table can store.
const STORED_PROVIDER = { MTN: "MTN_MOMO", MOMO: "MTN_MOMO", MTN_MOMO: "MTN_MOMO", AIRTEL: "AIRTEL_MONEY", AIRTEL_MONEY: "AIRTEL_MONEY" };
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

// What MVEC recorded for one provider transaction id: the processed webhook
// (order payments) or the successful payment itself (polled or standalone).
async function recordedAmount(id) {
  const log = await PaymentWebhookLog.findOne({ externalTransactionId: id, status: "PROCESSED" }).lean();
  if (log) return Number(log.amount);
  const payment = await Payment.findOne({
    status: { $in: ["SUCCESS", "REFUNDED"] },
    $or: [{ gatewayReference: id }, { transactionReference: id }],
  }).lean();
  return payment ? Number(payment.amount) : null;
}

// @desc    Compare a payment provider's statement with what MVEC recorded
// @route   POST /api/admin/reconcile
//          { statements: [{ provider, externalTransactionId, amount, transactionDate }], from?, to? }
// @access  Private (Super Admin)
// Every statement row is MATCHED, MISMATCHED (different amount) or
// MISSING_IN_LEDGER (the provider has money MVEC never recorded). With a
// from/to period, MVEC payments in that period that are not on the statement
// are listed as missingInStatement (recorded as paid, but no money arrived).
exports.runReconciliation = async (req, res) => {
  try {
    const statements = Array.isArray(req.body?.statements) ? req.body.statements : null;
    if (!statements || statements.length === 0) {
      return res.status(400).json({ message: "Send the provider statement rows as `statements`." });
    }
    if (statements.length > MAX_ROWS) {
      return res.status(400).json({ message: `Send at most ${MAX_ROWS} rows at a time.` });
    }

    const results = { totalProcessed: 0, matched: 0, mismatched: 0, missingInLedger: 0, statementTotal: 0, rows: [] };
    const seen = new Set();
    for (const stmt of statements) {
      const id = String(stmt?.externalTransactionId || "").trim();
      const amount = round(stmt?.amount);
      if (!id || !(amount > 0)) {
        results.rows.push({ externalTransactionId: id || null, status: "INVALID_ROW" });
        continue;
      }
      seen.add(id);
      results.totalProcessed += 1;
      results.statementTotal = round(results.statementTotal + amount);

      const recorded = await recordedAmount(id);
      let status = "MISSING_IN_LEDGER";
      if (recorded !== null) status = round(recorded) === amount ? "MATCHED" : "MISMATCHED";
      if (status === "MATCHED") results.matched += 1;
      else if (status === "MISMATCHED") results.mismatched += 1;
      else results.missingInLedger += 1;
      if (status !== "MATCHED") results.rows.push({ externalTransactionId: id, amount, recorded, status });

      const provider = STORED_PROVIDER[String(stmt.provider || "").toUpperCase()];
      if (provider) {
        await ProviderStatement.findOneAndUpdate(
          { externalTransactionId: id },
          { provider, externalTransactionId: id, amount, currency: stmt.currency || "RWF", transactionDate: stmt.transactionDate ? new Date(stmt.transactionDate) : new Date(), reconciliationStatus: status },
          { upsert: true },
        );
      }
    }

    let missingInStatement = null;
    const from = req.body.from ? new Date(req.body.from) : null;
    const to = req.body.to ? new Date(req.body.to) : null;
    if (from && to && !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) {
      const paid = await Payment.find({ status: { $in: ["SUCCESS", "REFUNDED"] }, paidAt: { $gte: from, $lte: to } })
        .select("transactionReference gatewayReference amount gateway paidAt").lean();
      missingInStatement = paid
        .filter((p) => !seen.has(String(p.gatewayReference || "")) && !seen.has(String(p.transactionReference || "")))
        .filter((p) => !String(p.gatewayReference || "").startsWith("SANDBOX"))
        .map((p) => ({ transactionReference: p.transactionReference, gatewayReference: p.gatewayReference, gateway: p.gateway, amount: p.amount, paidAt: p.paidAt }));
    }

    return res.status(200).json({
      success: true,
      message: results.mismatched || results.missingInLedger || missingInStatement?.length
        ? "Reconciliation found differences. Review the rows listed."
        : "Everything on the statement matches MVEC's records.",
      results: { ...results, missingInStatement },
    });
  } catch (error) {
    console.error("Reconciliation failed:", error);
    return res.status(500).json({ message: "Reconciliation could not be completed. Try again." });
  }
};
