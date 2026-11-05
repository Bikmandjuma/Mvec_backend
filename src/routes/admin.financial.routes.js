const express = require("express");
const router = express.Router();
const { getLedgerEntries, placeAdminHold, liftAdminHold, manualEscrowRelease } = require("../controllers/financial.controller");
const { runReconciliation } = require("../controllers/reconciliation.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

router.use(protect, authorize("super_admin"));

router.get("/ledger", getLedgerEntries);
router.patch("/settlements/:id/hold", placeAdminHold);
router.delete("/settlements/:id/hold", liftAdminHold);
router.post("/settlements/:id/release", manualEscrowRelease);
// Compare a payment provider statement with MVEC's records.
router.post("/reconcile", runReconciliation);

module.exports = router;