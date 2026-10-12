const mongoose = require("mongoose");
const Cart = require("../models/Cart");
const Product = require("../models/Product");
const { effectivePrice } = require("../utils/pricing.util");

const MAX_QTY_PER_LINE = 100;
const CART_PRODUCT_FIELDS = "name price discountPrice stockQuantity status media vendor sku";
const populateCart = (cart) =>
  cart.populate({
    path: "items.product",
    select: CART_PRODUCT_FIELDS,
    populate: { path: "vendor", select: "Fullname companyName" },
  });
const serverError = (res, error) => {
  console.error(error);
  return res.status(500).json({ message: "Something went wrong with your cart. Please try again." });
};

// @desc    Get user's shopping cart
// @route   GET /api/cart
// @access  Private
exports.getCart = async (req, res) => {
  try {
    let cart = await Cart.findOne({ user: req.user.id });

    if (!cart) {
      cart = await Cart.create({ user: req.user.id, items: [], totalAmount: 0 });
    } else {
      // Drop lines whose product was deleted and refresh prices so the cart
      // never shows a stale amount.
      const products = await Product.find({ _id: { $in: cart.items.map((i) => i.product) } })
        .select("price discountPrice");
      const byId = new Map(products.map((p) => [p._id.toString(), p]));
      const before = JSON.stringify(cart.items.map((i) => [String(i.product), i.price]));
      cart.items = cart.items.filter((i) => byId.has(String(i.product)));
      cart.items.forEach((i) => { i.price = effectivePrice(byId.get(String(i.product))); });
      if (JSON.stringify(cart.items.map((i) => [String(i.product), i.price])) !== before) {
        cart.calculateTotal();
        await cart.save();
      }
    }
    await populateCart(cart);

    return res.status(200).json({ cart });
  } catch (error) {
    return serverError(res, error);
  }
};

// @desc    Add item to cart (Blocks vendors from buying their own items)
// @route   POST /api/cart
// @access  Private
exports.addToCart = async (req, res) => {
  try {
    const { productId, quantity = 1 } = req.body;

    const requestedQuantity = Number(quantity);
    if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1 || requestedQuantity > MAX_QTY_PER_LINE) {
      return res.status(400).json({ message: "Quantity must be a whole number between 1 and 100" });
    }
    if (!productId || typeof productId !== "string") {
      return res.status(400).json({ message: "A product is required" });
    }

    // Accept old guest carts that stored the public MVEC product code, while
    // keeping Mongo ObjectIds as the canonical cart reference.
    const product = mongoose.isValidObjectId(productId)
      ? await Product.findById(productId)
      : await Product.findOne({ publicId: productId });
    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    // Check 1: Prevent vendors from buying their own products
    const productVendor = product.vendor && product.vendor.toString();
    if (productVendor && productVendor === req.user.id.toString()) {
      return res.status(403).json({
        message: "Action denied. You cannot add your own product to your cart.",
      });
    }

    // Check 2: Stock availability check
    if (product.status === "OUT_OF_STOCK" || product.stockQuantity < 1) {
      return res.status(400).json({ message: "Product is out of stock" });
    }
    if (product.status !== "ACTIVE") {
      return res.status(400).json({ message: "This product is not available for purchase" });
    }

    let cart = await Cart.findOne({ user: req.user.id });

    if (!cart) {
      cart = new Cart({ user: req.user.id, items: [] });
    }

    const existingItemIndex = cart.items.findIndex(
      (item) => item.product && item.product.toString() === product._id.toString()
    );

    const targetQuantity = existingItemIndex > -1
      ? cart.items[existingItemIndex].quantity + requestedQuantity
      : requestedQuantity;

    // Check 3: Check requested quantity against stock quantity
    if (targetQuantity > product.stockQuantity) {
      return res.status(400).json({
        message: `Cannot request more than available stock (${product.stockQuantity} remaining)`,
      });
    }

    const activePrice = effectivePrice(product);

    if (existingItemIndex > -1) {
      cart.items[existingItemIndex].quantity = targetQuantity;
      cart.items[existingItemIndex].price = activePrice;
    } else {
      cart.items.push({
        product: product._id,
        quantity: targetQuantity,
        price: activePrice,
      });
    }

    cart.calculateTotal();
    await cart.save();
    await populateCart(cart);

    return res.status(200).json({ message: "Item added to cart", cart });
  } catch (error) {
    return serverError(res, error);
  }
};

// @desc    Update cart item quantity
// @route   PUT /api/cart/items/:productId
// @access  Private
exports.updateCartItemQuantity = async (req, res) => {
  try {
    const { productId } = req.params;
    const quantity = Number(req.body.quantity);

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY_PER_LINE) {
      return res.status(400).json({ message: "Quantity must be a whole number between 1 and 100" });
    }

    if (!mongoose.isValidObjectId(productId)) {
      return res.status(404).json({ message: "Item not in cart" });
    }

    const cart = await Cart.findOne({ user: req.user.id });
    if (!cart) {
      return res.status(404).json({ message: "Cart not found" });
    }

    const itemIndex = cart.items.findIndex(
      (item) => item.product && item.product.toString() === productId
    );

    if (itemIndex === -1) {
      return res.status(404).json({ message: "Item not in cart" });
    }

    const product = await Product.findById(productId);
    if (!product || product.status !== "ACTIVE") {
      return res.status(400).json({ message: "This product is no longer available. Please remove it from your cart." });
    }
    if (quantity > product.stockQuantity) {
      return res.status(400).json({
        message: `Only ${product.stockQuantity} left in stock`,
      });
    }

    cart.items[itemIndex].quantity = quantity;
    cart.items[itemIndex].price = effectivePrice(product);
    cart.calculateTotal();
    await cart.save();

    await populateCart(cart);

    return res.status(200).json({ message: "Cart updated", cart });
  } catch (error) {
    return serverError(res, error);
  }
};

// @desc    Remove item from cart
// @route   DELETE /api/cart/items/:productId
// @access  Private
exports.removeFromCart = async (req, res) => {
  try {
    const { productId } = req.params;

    if (!mongoose.isValidObjectId(productId)) {
      return res.status(404).json({ message: "Item not in cart" });
    }

    const cart = await Cart.findOne({ user: req.user.id });
    if (!cart) {
      return res.status(404).json({ message: "Cart not found" });
    }

    cart.items = cart.items.filter(
      (item) => item.product && item.product.toString() !== productId
    );

    cart.calculateTotal();
    await cart.save();

    await populateCart(cart);

    return res.status(200).json({ message: "Item removed from cart", cart });
  } catch (error) {
    return serverError(res, error);
  }
};

// @desc    Clear all items in cart
// @route   DELETE /api/cart
// @access  Private
exports.clearCart = async (req, res) => {
  try {
    const cart = await Cart.findOne({ user: req.user.id });
    if (cart) {
      cart.items = [];
      cart.totalAmount = 0;
      await cart.save();
    }
    return res.status(200).json({ message: "Cart cleared" });
  } catch (error) {
    return serverError(res, error);
  }
};
