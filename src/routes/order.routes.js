const express = require("express");
const router = express.Router();

const {
  createCheckoutOrder,
  directCheckout,
  getMyOrders,
  getDeliverable,
  getOrderById,
  getVendorOrders,
  updateVendorOrderStatus,
  updateOrderStatus,
  confirmOrderDelivery,
  getAllOrders,
  cancelOrderByBuyer,
  assignCourier,
  markOutForDelivery,
} = require("../controllers/order.controller");

const { checkStaffPermission } = require("../middleware/staff.middleware");
const { checkSupplierPermission } = require("../middleware/supplierTeam.middleware");
const { supplierOwnerOf } = require("../utils/accountOwner.util");

// Suppliers sell published products to buyers too. They and their team work on
// orders as the supplier owner (req.vendorId). Any active team member may read;
// changes need `capability`. Other roles pass through untouched.
const supplierSeller = (capability) => (req, res, next) => {
  if (req.user.role !== "supplier") return next();
  const resolveOwner = async () => {
    try {
      const owner = await supplierOwnerOf(req.user);
      if (!owner) return res.status(403).json({ message: "Supplier profile not found. Complete onboarding first." });
      req.vendorId = owner.userId;
      return next();
    } catch (e) {
      return next(e);
    }
  };
  if (!capability) return resolveOwner();
  return checkSupplierPermission(capability)(req, res, (error) => (error ? next(error) : resolveOwner()));
};
// Vendors go through staff rules, suppliers through their team roles.
const sellerOrders = (permission) => (req, res, next) =>
  (req.user.role === "supplier" ? supplierSeller("supply") : checkStaffPermission(permission))(req, res, next);
const { protect, authorize } = require("../middleware/auth.middleware");
const limits = require("../middleware/rateLimits");

// Require authentication for all order routes
router.use(protect);

router.get("/", authorize("super_admin", "admin"), getAllOrders);
router.post("/checkout", limits.checkout, createCheckoutOrder);
router.post("/direct-checkout", limits.checkout, directCheckout);
router.get("/my-orders", getMyOrders);
// Keep this before /:id; otherwise "deliverable" is parsed as an order ID.
router.get("/deliverable", authorize("delivery", "courier", "vendor", "supplier", "super_admin"), supplierSeller(), getDeliverable);
router.get("/vendor/orders", authorize("vendor", "supplier"), supplierSeller(), getVendorOrders);
// Seller records an order taken outside the online checkout (staff need the orders permission).
router.post("/vendor/manual", authorize("vendor"), checkStaffPermission("canManageOrders"), limits.checkout, require("../controllers/manualOrder.controller").createManualOrder);
router.get("/:id", getOrderById);
router.post("/:id/cancel", protect, cancelOrderByBuyer);
// Vendor fulfilment updates (excluding delivery payout triggers). Staff need
// the order permission; the handler also checks the order has their items.
router.patch(
  "/vendor/status",
  authorize("vendor", "supplier", "super_admin"),
  sellerOrders("canManageOrders"),
  updateVendorOrderStatus,
);
router.patch(
  "/:id/status",
  protect,
  authorize("vendor", "admin", "super_admin"),
  updateOrderStatus,
);

// Direct route for confirming delivery and unlocking earnings
router.patch("/:id/deliver", protect, authorize("super_admin", "courier", "delivery", "vendor", "supplier"), supplierSeller("supply"), confirmOrderDelivery);
router.patch("/:id/courier", protect, authorize("super_admin"), assignCourier);
router.patch("/:id/out-for-delivery", protect, authorize("super_admin", "delivery", "courier"), markOutForDelivery);


module.exports = router;
