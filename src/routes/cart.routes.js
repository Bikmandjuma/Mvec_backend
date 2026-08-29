const express = require("express");
const router = express.Router();

const {
  getCart,
  addToCart,
  updateCartItemQuantity,
  removeFromCart,
  clearCart,
} = require("../controllers/cart.controller");

const { protect } = require("../middleware/auth.middleware");

// Require authentication for all cart operations
router.use(protect);

router.get("/", getCart);
router.post("/", addToCart);
router.delete("/", clearCart);

router.put("/items/:productId", updateCartItemQuantity);
router.delete("/items/:productId", removeFromCart);

module.exports = router;