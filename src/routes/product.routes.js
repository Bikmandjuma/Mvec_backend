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
} = require("../controllers/product.controller");

const { protect } = require("../middleware/auth.middleware");
const { authorize } = require("../middleware/auth.middleware");

// Public route for Buyers & Admin to browse products
router.get("/", getAllProducts);

// Placed these above router.use(protect);
router.get("/slug/:slug", getProductBySlug);
router.get("/:id", getProductById);


// Protected routes (Require authentication)
router.use(protect);

// Route for vendor dashboard to get ONLY their own products
router.get("/vendor/me", authorize("vendor"), getVendorProducts);


// Create, Update, Delete routes
router.post("/", authorize("vendor", "super_admin"), createProduct);
router.put("/:id", authorize("vendor", "super_admin"), updateProduct);
router.delete("/:id", authorize("vendor", "super_admin"), deleteProduct);

module.exports = router;