const express = require("express");
const router = express.Router();
const { getLedgerEntries, placeAdminHold, manualEscrowRelease } = require("../controllers/financial.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

router.use(protect, authorize("super_admin"));

router.get("/ledger", getLedgerEntries);
router.patch("/settlements/:id/hold", placeAdminHold);
router.post("/settlements/:id/release", manualEscrowRelease);

module.exports = router;