const express = require("express");
const router = express.Router();

const {
  createCheckoutOrder,
  getMyOrders,
  getOrderById,
  getVendorOrders,
  updateVendorOrderStatus,
  updateOrderStatus,
  confirmOrderDelivery
} = require("../controllers/order.controller");

const { checkStaffPermission } = require("../middleware/staff.middleware");
const { protect, authorize } = require("../middleware/auth.middleware");

// Require authentication for all order routes
router.use(protect);

router.post("/checkout", createCheckoutOrder);
router.get("/my-orders", getMyOrders);
router.get("/vendor/orders", authorize("vendor"), getVendorOrders);
router.get("/:id", getOrderById);
router.patch(
  "/vendor/status",
  protect,
  authorize("vendor", "super_admin"),
  updateVendorOrderStatus,
);

router.patch(
  "/vendor/status",
  checkStaffPermission("canManageOrders"),
  updateVendorOrderStatus,
);
router.patch(
  "/:id/status",
  protect,
  authorize("vendor", "admin", "super_admin"),
  updateOrderStatus,
);

// Direct route for confirming delivery and unlocking earnings
router.patch("/:id/deliver", protect, authorize("super_admin", "courier"), confirmOrderDelivery);

// Status route for general vendor updates (excluding delivery payout triggers)
router.patch("/vendor/status", protect, authorize("vendor", "super_admin"), updateVendorOrderStatus);

module.exports = router;
