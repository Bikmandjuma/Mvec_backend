const ProviderStatement = require("../models/ProviderStatement");
const PaymentWebhookLog = require("../models/PaymentWebhookLog");

// @desc    Reconcile imported provider statement against ledger
// @route   POST /api/admin/reconcile
// @access  Private (Super Admin)
exports.runReconciliation = async (req, res) => {
  try {
    const { statements } = req.body; // Array of provider records [{ provider, externalTransactionId, amount, transactionDate }]

    const reconciliationResults = {
      totalProcessed: statements.length,
      matched: 0,
      mismatched: 0,
      missingInLedger: 0,
    };

    for (const stmt of statements) {
      const webhookLog = await PaymentWebhookLog.findOne({
        externalTransactionId: stmt.externalTransactionId,
      });

      let status = "MISSING_IN_LEDGER";

      if (webhookLog) {
        if (webhookLog.amount === stmt.amount && webhookLog.status === "PROCESSED") {
          status = "MATCHED";
          reconciliationResults.matched += 1;
        } else {
          status = "MISMATCHED";
          reconciliationResults.mismatched += 1;
        }
      } else {
        reconciliationResults.missingInLedger += 1;
      }

      await ProviderStatement.findOneAndUpdate(
        { externalTransactionId: stmt.externalTransactionId },
        { ...stmt, reconciliationStatus: status },
        { upsert: true }
      );
    }

    return res.status(200).json({
      success: true,
      message: "Reconciliation completed successfully.",
      results: reconciliationResults,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};