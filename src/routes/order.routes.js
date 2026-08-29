const express = require("express");
const router = express.Router();

const {
  createCheckoutOrder,
  getMyOrders,
  getOrderById,
  getVendorOrders,
  updateVendorOrderStatus,
} = require("../controllers/order.controller");

const { protect, authorize } = require("../middleware/auth.middleware");

// Require authentication for all order routes
router.use(protect);

router.post("/checkout", createCheckoutOrder);
router.get("/my-orders", getMyOrders);
router.get("/vendor/orders", authorize("vendor"), getVendorOrders);
router.get("/:id", getOrderById);
router.patch("/vendor/status", protect, authorize("vendor", "super_admin"), updateVendorOrderStatus);

module.exports = router;