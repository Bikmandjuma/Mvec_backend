const express = require("express");
const router = express.Router();
const {
  getAllProducts,
  getVendorProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  getProductById,
  getProductBySlug,
  getRecommendations,
} = require("../controllers/product.controller");
const { adjustStock, moveProductsToStore, listStockMovements } = require("../controllers/inventory.controller");
const { checkStaffPermission } = require("../middleware/staff.middleware");

const { protect, optionalProtect } = require("../middleware/auth.middleware");
const { authorize, requireOnboarded } = require("../middleware/auth.middleware");

// Public route for Buyers & Admin to browse products
router.get("/", getAllProducts);

// Flash deals (before "/:id" so the word isn't read as an id)
router.get("/deals", require("../controllers/product.controller").getDeals);

// Recommendations route - products sorted by rating and recency
router.get("/recommendations", optionalProtect, getRecommendations);

// Placed these above router.use(protect);
router.get("/slug/:slug", getProductBySlug);

// Single live product by id (public so guests can open product pages).
// "/vendor/me" has two segments, so it is never captured by this route.
router.get("/:id", optionalProtect, getProductById);


// Protected routes (Require authentication)
router.use(protect);

// Buyers: back-in-stock and price-drop alerts.
const alerts = require("../services/alerts.service");
const alertRun = (fn) => async (req, res) => {
  try { return res.status(200).json(await fn(req)); } catch (e) { return res.status(e.statusCode || 500).json({ message: e.statusCode ? e.message : "Could not update the alert." }); }
};
router.get("/alerts/mine", alertRun((req) => alerts.mine(req.user)));
router.get("/:id/alerts", alertRun((req) => alerts.onProduct(req.user, req.params.id)));
router.post("/:id/alerts", alertRun((req) => alerts.subscribe(req.user, req.params.id, req.body?.kind)));
router.delete("/:id/alerts/:kind", alertRun((req) => alerts.unsubscribe(req.user, req.params.id, req.params.kind)));

// Route for vendor dashboard to get ONLY their own products.
// Registered BEFORE "/:id" so the literal segment never gets swallowed by route params.
router.get("/vendor/me", authorize("vendor"), getVendorProducts);

// Inventory operations (stock movements history, bulk store moves)
router.get("/vendor/stock-movements", authorize("vendor"), listStockMovements);
router.post("/vendor/move-store", requireOnboarded, checkStaffPermission("canManageProducts"), moveProductsToStore);


// Vendors and super_admins can always manage their own products.
// Staff with the 'canManageProducts' permission can manage on behalf of the store owner.
// checkStaffPermission already passes through if the user IS the store owner or super_admin,
// so it covers all three cases in a single middleware chain.
router.post("/", requireOnboarded, checkStaffPermission("canManageProducts"), createProduct);
router.post("/bulk", requireOnboarded, checkStaffPermission("canManageProducts"), require("../services/plans.service").requireFeature("bulkUpload"), require("../controllers/product.controller").bulkCreateProducts);
router.put("/:id", requireOnboarded, checkStaffPermission("canManageProducts"), updateProduct);
router.put("/:id/variants", requireOnboarded, checkStaffPermission("canManageProducts"), require("../controllers/product.controller").setProductVariants);
router.patch("/:id/stock", requireOnboarded, checkStaffPermission("canManageProducts"), adjustStock);
router.delete("/:id", requireOnboarded, checkStaffPermission("canManageProducts"), deleteProduct);


module.exports = router;
