const express = require("express");
const router = express.Router();
const wholesaleController = require("../controllers/wholesale.controller");
const { protect, authorize } = require("../middleware/auth.middleware"); // Adjust import path if needed

// Vendor creates supply order (MOQ check enforced)
router.post(
  "/orders",
  protect,
  authorize("vendor", "super_admin"),
  wholesaleController.createWholesaleOrder
);

// Escrow hold status transition on payment completion
router.post(
  "/orders/:orderId/hold-escrow",
  protect,
  wholesaleController.holdEscrow
);

// Vendor/Supplier confirms delivery receipt & releases escrow funds
router.post(
  "/orders/:orderId/confirm-receipt",
  protect,
  wholesaleController.confirmReceipt
);

module.exports = router;