const express = require("express");
const router = express.Router();
const c = require("../controllers/wholesale.controller");
const { protect, authorize, requireOnboarded } = require("../middleware/auth.middleware");
const { checkStaffPermission } = require("../middleware/staff.middleware");
const { checkSupplierPermission } = require("../middleware/supplierTeam.middleware");

// Seller staff need the orders permission; supplier team members need "supply".
const vendorSide = [protect, authorize("vendor", "super_admin"), checkStaffPermission("canManageOrders")];
const supplierSide = [protect, authorize("supplier"), requireOnboarded, checkSupplierPermission("supply")];

// Both sides: my wholesale orders (vendor: purchases, supplier: sales).
router.get("/orders/mine", protect, authorize("vendor", "supplier", "super_admin"), (req, res, next) => (req.user.role === "supplier" ? next() : checkStaffPermission("canManageOrders")(req, res, next)), c.listMyWholesaleOrders);

// Vendor: order from a supplier's catalog, pay, confirm receipt, report a problem, cancel before shipping.
router.post("/orders", ...vendorSide, requireOnboarded, c.createWholesaleOrder);
router.post("/orders/:orderId/pay", ...vendorSide, c.payWholesaleOrder);
router.post("/orders/:orderId/confirm-receipt", ...vendorSide, c.confirmReceipt);
router.post("/orders/:orderId/report-problem", ...vendorSide, c.reportProblem);
router.post("/orders/:orderId/cancel", protect, authorize("vendor", "supplier", "super_admin"), (req, res, next) => (req.user.role === "supplier" ? checkSupplierPermission("supply")(req, res, next) : checkStaffPermission("canManageOrders")(req, res, next)), c.cancelOrder);

// Supplier: ship a paid order.
router.post("/orders/:orderId/ship", ...supplierSide, c.markShipped);

// Admin: oversight, disputes, and orders paid outside MVEC (all audited).
router.get("/admin/orders", protect, authorize("super_admin"), c.adminList);
router.post("/admin/orders/:orderId/resolve", protect, authorize("super_admin"), c.adminResolve);
router.post("/orders/:orderId/hold-escrow", protect, authorize("super_admin"), c.holdEscrow);

module.exports = router;
