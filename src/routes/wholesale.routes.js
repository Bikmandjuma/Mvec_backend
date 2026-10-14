const express = require("express");
const router = express.Router();
const wholesaleController = require("../controllers/wholesale.controller");
const { protect, authorize, requireOnboarded } = require("../middleware/auth.middleware"); // Adjust import path if needed

// Vendor creates supply order (MOQ check enforced)
router.get(
  "/orders/mine",
  protect,
  authorize("vendor", "supplier"),
  wholesaleController.listMyWholesaleOrders
);
router.post(
  "/orders",
  protect,
  authorize("vendor", "super_admin"),
  requireOnboarded,
  wholesaleController.createWholesaleOrder
);

// Suppliers mark an escrow-funded order as shipped.
router.post(
  "/orders/:orderId/ship",
  protect,
  authorize("supplier"),
  requireOnboarded,
  wholesaleController.markShipped
);

// The vendor pays the order; it is held in escrow once the provider confirms.
router.post(
  "/orders/:orderId/pay",
  protect,
  authorize("vendor", "super_admin"),
  wholesaleController.payWholesaleOrder
);

// Manual escrow hold, for an order an admin confirmed was paid outside MVEC
// (audited). Vendors pay through /pay; nobody else can mark an order paid.
router.post(
  "/orders/:orderId/hold-escrow",
  protect,
  authorize("super_admin"),
  wholesaleController.holdEscrow
);

// Vendor/Supplier confirms delivery receipt & releases escrow funds
router.post(
  "/orders/:orderId/confirm-receipt",
  protect,
  authorize("vendor"),
  wholesaleController.confirmReceipt
);

module.exports = router;
