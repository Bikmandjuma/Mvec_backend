const Store = require("../models/Store");
const Product = require("../models/Product");

// Helper to convert store name to URL slug
const createSlug = (text) => {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w\-]+/g, "")
    .replace(/\-\-+/g, "-");
};

// @desc    Create a new store (Vendor)
// @route   POST /api/stores
// @access  Private (Vendor)
exports.createStore = async (req, res) => {
  try {
    const existingStore = await Store.findOne({ vendor: req.user.id });
    if (existingStore) {
      return res.status(400).json({ message: "You already have a store profile registered." });
    }

    const { storeName, description, businessCategory, contactEmail, contactPhone, address, policies } = req.body;

    if (!storeName || !contactEmail || !contactPhone) {
      return res.status(400).json({ message: "Store name, email, and phone are required." });
    }

    const slug = createSlug(storeName);
    const slugExists = await Store.findOne({ slug });
    if (slugExists) {
      return res.status(400).json({ message: "A store with this name already exists." });
    }

    const store = await Store.create({
      vendor: req.user.id,
      storeName,
      slug,
      description,
      businessCategory,
      contactEmail,
      contactPhone,
      address,
      policies,
      status: "ACTIVE", // Or PENDING if requiring Super Admin approval
    });

    return res.status(201).json({ message: "Store created successfully", store });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Get logged-in vendor's store details
// @route   GET /api/stores/mine
// @access  Private (Vendor)
exports.getMyStore = async (req, res) => {
  try {
    const store = await Store.findOne({ vendor: req.user.id });
    if (!store) {
      return res.status(404).json({ message: "No store found for this vendor." });
    }
    return res.status(200).json({ store });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Update store details (Vendor)
// @route   PUT /api/stores/mine
// @access  Private (Vendor)
exports.updateMyStore = async (req, res) => {
  try {
    const store = await Store.findOne({ vendor: req.user.id });
    if (!store) {
      return res.status(404).json({ message: "Store profile not found." });
    }

    // Do not allow vendors to directly override approval status
    delete req.body.status;
    delete req.body.vendor;

    const updatedStore = await Store.findByIdAndUpdate(store._id, req.body, {
      new: true,
      runValidators: true,
    });

    return res.status(200).json({ message: "Store updated successfully", store: updatedStore });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Get public store profile & products by slug (Marketplace)
// @route   GET /api/stores/public/:slug
// @access  Public
exports.getPublicStoreBySlug = async (req, res) => {
  try {
    const store = await Store.findOne({ slug: req.params.slug, status: "ACTIVE" }).populate(
      "vendor",
      "Fullname email"
    );

    if (!store) {
      return res.status(404).json({ message: "Store not found or currently inactive." });
    }

    // Fetch active products listed by this store's vendor
    const products = await Product.find({ vendor: store.vendor._id, status: "ACTIVE" });

    return res.status(200).json({ store, productsCount: products.length, products });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};