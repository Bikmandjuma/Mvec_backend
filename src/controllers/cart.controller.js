const orm = require("../database/orm");
const Cart = require("../models/Cart");
const Product = require("../models/Product");
const ProductVariant = require("../models/ProductVariant");
const { PRICE_FIELDS } = require("../utils/pricing.util");
const variants = require("../services/variant.service");

const MAX_QTY_PER_LINE = 100;
const CART_PRODUCT_FIELDS = `name ${PRICE_FIELDS} stockQuantity status media vendor sku`;
const sameLine = (item, productId, variantId) =>
  item.product && item.product.toString() === String(productId) && String(item.variant || "") === String(variantId || "");

/**
 * The cart as clients get it: each line also carries `lineId` (the key for
 * update/remove: "productId" or "productId~variantId"), and for a variant its
 * label and own stock.
 */
async function respond(res, cart, extra = {}) {
  await populateCart(cart);
  const plain = JSON.parse(JSON.stringify(cart));
  const ids = (plain.items || []).map((i) => i.variant).filter(Boolean);
  const rows = ids.length ? await ProductVariant.find({ _id: { $in: ids } }).lean() : [];
  const byId = new Map(rows.map((v) => [String(v._id), v]));
  plain.items = (plain.items || []).map((i) => {
    const v = i.variant ? byId.get(String(i.variant)) : null;
    const productId = i.product?._id || i.product?.id || i.product;
    return { ...i, lineId: variants.keyOf(productId, i.variant), variantLabel: v?.label || null, variantStock: v ? Number(v.stockQuantity) : null, image: v?.image || null };
  });
  return res.status(200).json({ ...extra, cart: plain });
}
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
        .select(PRICE_FIELDS);
      const byId = new Map(products.map((p) => [p._id.toString(), p]));
      const options = await variants.byProduct(products.map((p) => p._id));
      const variantOf = (i) => (options.get(String(i.product)) || []).find((v) => String(v._id) === String(i.variant || ""));
      const before = JSON.stringify(cart.items.map((i) => [String(i.product), i.price]));
      // A line for a removed variant (or a variant line on a product without any) goes.
      cart.items = cart.items.filter((i) => byId.has(String(i.product)) && (!i.variant || variantOf(i)));
      cart.items.forEach((i) => { i.price = variants.priceOf(byId.get(String(i.product)), variantOf(i)); });
      if (JSON.stringify(cart.items.map((i) => [String(i.product), i.price])) !== before) {
        cart.calculateTotal();
        await cart.save();
      }
    }
    return await respond(res, cart);
  } catch (error) {
    return serverError(res, error);
  }
};

// @desc    Add item to cart (Blocks vendors from buying their own items)
// @route   POST /api/cart
// @access  Private
exports.addToCart = async (req, res) => {
  try {
    const { quantity = 1 } = req.body;
    const key = variants.parseKey(req.body.productId);
    const productId = key.productId;
    const variantId = req.body.variantId ? String(req.body.variantId) : key.variantId;

    const requestedQuantity = Number(quantity);
    if (!Number.isInteger(requestedQuantity) || requestedQuantity < 1 || requestedQuantity > MAX_QTY_PER_LINE) {
      return res.status(400).json({ message: "Quantity must be a whole number between 1 and 100" });
    }
    if (!productId || typeof productId !== "string") {
      return res.status(400).json({ message: "A product is required" });
    }

    // Accept old guest carts that stored the public Ikiguzi product code, while
    // keeping Mongo ObjectIds as the canonical cart reference.
    const product = orm.isValidObjectId(productId)
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

    // Check 3: a product with sizes/colours is added as one of them.
    const options = (await variants.byProduct([product._id])).get(String(product._id)) || [];
    const variant = variantId ? options.find((v) => String(v._id) === variantId) : null;
    if (options.length && !variant) {
      return res.status(400).json({ message: variantId ? "That option is no longer sold. Choose another." : "Choose a size or colour first.", code: "VARIANT_REQUIRED" });
    }
    const available = variant ? Number(variant.stockQuantity) : product.stockQuantity;
    if (available < 1) return res.status(400).json({ message: `${variant ? variant.label : "This product"} is out of stock` });

    let cart = await Cart.findOne({ user: req.user.id });

    if (!cart) {
      cart = new Cart({ user: req.user.id, items: [] });
    }

    const existingItemIndex = cart.items.findIndex((item) => sameLine(item, product._id, variant?._id));

    const targetQuantity = existingItemIndex > -1
      ? cart.items[existingItemIndex].quantity + requestedQuantity
      : requestedQuantity;

    // Check 4: Check requested quantity against stock quantity
    if (targetQuantity > available) {
      return res.status(400).json({
        message: `Cannot request more than available stock (${available} remaining)`,
      });
    }

    const activePrice = variants.priceOf(product, variant);

    if (existingItemIndex > -1) {
      cart.items[existingItemIndex].quantity = targetQuantity;
      cart.items[existingItemIndex].price = activePrice;
    } else {
      cart.items.push({
        product: product._id,
        variant: variant?._id || null,
        quantity: targetQuantity,
        price: activePrice,
      });
    }

    cart.calculateTotal();
    await cart.save();
    return await respond(res, cart, { message: "Item added to cart" });
  } catch (error) {
    return serverError(res, error);
  }
};

// @desc    Update cart item quantity
// @route   PUT /api/cart/items/:productId
// @access  Private
exports.updateCartItemQuantity = async (req, res) => {
  try {
    const { productId, variantId } = variants.parseKey(req.params.productId);
    const quantity = Number(req.body.quantity);

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY_PER_LINE) {
      return res.status(400).json({ message: "Quantity must be a whole number between 1 and 100" });
    }

    if (!orm.isValidObjectId(productId)) {
      return res.status(404).json({ message: "Item not in cart" });
    }

    const cart = await Cart.findOne({ user: req.user.id });
    if (!cart) {
      return res.status(404).json({ message: "Cart not found" });
    }

    const itemIndex = cart.items.findIndex((item) => sameLine(item, productId, variantId));

    if (itemIndex === -1) {
      return res.status(404).json({ message: "Item not in cart" });
    }

    const product = await Product.findById(productId);
    if (!product || product.status !== "ACTIVE") {
      return res.status(400).json({ message: "This product is no longer available. Please remove it from your cart." });
    }
    const variant = variantId ? await ProductVariant.findOne({ _id: variantId, product: productId }).lean() : null;
    if (variantId && !variant) return res.status(400).json({ message: "That option is no longer sold. Remove it from your cart." });
    const available = variant ? Number(variant.stockQuantity) : product.stockQuantity;
    if (quantity > available) {
      return res.status(400).json({
        message: `Only ${available} left in stock`,
      });
    }

    cart.items[itemIndex].quantity = quantity;
    cart.items[itemIndex].price = variants.priceOf(product, variant);
    cart.calculateTotal();
    await cart.save();

    return await respond(res, cart, { message: "Cart updated" });
  } catch (error) {
    return serverError(res, error);
  }
};

// @desc    Remove item from cart
// @route   DELETE /api/cart/items/:productId
// @access  Private
exports.removeFromCart = async (req, res) => {
  try {
    const { productId, variantId } = variants.parseKey(req.params.productId);

    if (!orm.isValidObjectId(productId)) {
      return res.status(404).json({ message: "Item not in cart" });
    }

    const cart = await Cart.findOne({ user: req.user.id });
    if (!cart) {
      return res.status(404).json({ message: "Cart not found" });
    }

    cart.items = cart.items.filter((item) => !sameLine(item, productId, variantId));

    cart.calculateTotal();
    await cart.save();

    return await respond(res, cart, { message: "Item removed from cart" });
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
