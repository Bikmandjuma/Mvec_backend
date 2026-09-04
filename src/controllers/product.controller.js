const Product = require("../models/Product");

// @desc    Get all active products for buyers (Public)
// @route   GET /api/products
// @access  Public / Buyer / Admin
exports.getAllProducts = async (req, res) => {
  try {
    const products = await Product.find({ status: "ACTIVE" })
      .populate("vendor", "Fullname companyName email")
      .populate("category", "name slug");

    return res.status(200).json({ count: products.length, products });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Get logged-in vendor's OWN products only
// @route   GET /api/products/vendor/me
// @access  Private (Vendor Only)
exports.getVendorProducts = async (req, res) => {
  try {
    const products = await Product.find({ vendor: req.user.id }).populate(
      "category",
      "name",
    );

    return res.status(200).json({ count: products.length, products });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Create a product (Vendor / Admin)
// @route   POST /api/products
// @access  Private (Vendor / Admin)
exports.createProduct = async (req, res) => {
  try {
    const product = new Product({
      ...req.body,
      vendor: req.user.id,
    });

    await product.save();
    return res.status(201).json({ message: "Product created successfully", product });
  } catch (error) {
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern || {})[0] || "field";
      return res.status(409).json({
        message: `A product with this ${field} already exists. Please choose a different ${field}.`,
      });
    }
    return res.status(400).json({ message: error.message });
  }
};

// @desc    Update product (Vendor updates OWN product; Admin updates any)
// @route   PUT /api/products/:id
// @access  Private (Vendor / Admin)
// @desc    Update product (Vendor updates OWN product; Admin updates any)
// @route   PUT /api/products/:id
// @access  Private (Vendor / Admin)
exports.updateProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    // 1. Ownership check — vendor can only edit their OWN product
    if (
      req.user.role !== "super_admin" &&
      product.vendor.toString() !== req.user.id.toString()
    ) {
      return res.status(403).json({
        message: "Access denied. You can only update your own products.",
      });
    }

    // 2. Admin cannot alter stock quantity on a vendor's product
    if (
      req.user.role === "super_admin" &&
      product.vendor.toString() !== req.user.id.toString() &&
      req.body.stockQuantity !== undefined &&
      req.body.stockQuantity !== product.stockQuantity
    ) {
      return res.status(403).json({
        message:
          "Access denied. Admin is not allowed to modify vendor stock quantity.",
      });
    }

    // 2. Prepare payload copy
    const updates = { ...req.body };

    // Prevent changing immutable unique indexes
    delete updates.sku;
    delete updates.slug;

    // Add before product.save() inside updateProduct
    if (updates.stockQuantity !== undefined) {
      if (updates.stockQuantity <= 0) {
        updates.stockQuantity = 0;
        updates.status = "OUT_OF_STOCK";
      } else if (
        product.status === "OUT_OF_STOCK" &&
        updates.stockQuantity > 0
      ) {
        updates.status = "ACTIVE"; // Auto-reactivate when re-stocked
      }
    }
    // 3. Apply updates and save
    Object.assign(product, updates);
    await product.save();

    return res
      .status(200)
      .json({ message: "Product updated successfully", product });
  } catch (error) {
    return res.status(400).json({ message: error.message });
  }
};

// @desc    Delete product (Vendor deletes OWN product; Admin deletes any)
// @route   DELETE /api/products/:id
// @access  Private (Vendor / Admin)
exports.deleteProduct = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    // Ownership check
    if (
      req.user.role !== "super_admin" &&
      product.vendor.toString() !== req.user.id.toString()
    ) {
      return res.status(403).json({
        message: "Access denied. You can only delete your own products.",
      });
    }

    await product.deleteOne();
    return res.status(200).json({ message: "Product deleted successfully" });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Get single product details by ID (Public)
// @route   GET /api/products/:id
// @access  Public
exports.getProductById = async (req, res) => {
  try {
    const product = await Product.findById(req.params.id)
      .populate("vendor", "Fullname companyName email")
      .populate("category", "name slug");

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    return res.status(200).json({ product });
  } catch (error) {
    console.error("Error fetching product by ID:", error);
    return res
      .status(500)
      .json({ message: "Invalid Product ID or server error" });
  }
};

// @desc    Get single product details by Slug (Public / SEO Friendly)
// @route   GET /api/products/slug/:slug
// @access  Public
exports.getProductBySlug = async (req, res) => {
  try {
    const product = await Product.findOne({ slug: req.params.slug })
      .populate("vendor", "Fullname companyName email")
      .populate("category", "name slug");

    if (!product) {
      return res.status(404).json({ message: "Product not found" });
    }

    return res.status(200).json({ product });
  } catch (error) {
    console.error("Error fetching product by slug:", error);
    return res.status(500).json({ message: error.message });
  }
};


// @desc    Advanced product search & filtering
// @route   GET /api/products/search
// @access  Public
exports.searchProducts = async (req, res) => {
  try {
    const {
      q,
      category,
      brand,
      minPrice,
      maxPrice,
      color,
      size,
      sort,
      page = 1,
      limit = 20,
    } = req.query;

    // Base filter: Only active products are visible to public buyers
    const filter = { status: "ACTIVE" };

    // 1. Text Search (Matches name, description, sku, brand)
    if (q) {
      filter.$text = { $search: q };
    }

    // 2. Category Filter
    if (category) {
      filter.category = category;
    }

    // 3. Brand Filter
    if (brand) {
      filter.brand = { $regex: brand, $options: "i" };
    }

    // 4. Price Range Filter
    if (minPrice || maxPrice) {
      filter.price = {};
      if (minPrice) filter.price.$gte = Number(minPrice);
      if (maxPrice) filter.price.$lte = Number(maxPrice);
    }

    // 5. Dynamic Attributes Filter
    if (color) filter["attributes.color"] = { $regex: color, $options: "i" };
    if (size) filter["attributes.size"] = { $regex: size, $options: "i" };

    // 6. Sorting Setup
    let sortOptions = {};
    if (q && !sort) {
      // Default to text score relevance when searching keywords
      sortOptions = { score: { $meta: "textScore" } };
    } else if (sort === "price_asc") {
      sortOptions = { price: 1 };
    } else if (sort === "price_desc") {
      sortOptions = { price: -1 };
    } else if (sort === "newest") {
      sortOptions = { createdAt: -1 };
    } else {
      sortOptions = { createdAt: -1 };
    }

    // 7. Pagination
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);
    const skip = (pageNum - 1) * limitNum;

    // Projection for text search score relevance
    const projection = q ? { score: { $meta: "textScore" } } : {};

    const [products, total] = await Promise.all([
      Product.find(filter, projection)
        .sort(sortOptions)
        .skip(skip)
        .limit(limitNum)
        .populate("vendor", "Fullname companyName email")
        .populate("category", "name slug"),
      Product.countDocuments(filter),
    ]);

    return res.status(200).json({
      meta: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
      },
      products: products.length != 0 ? products : "Sorry, no products found matching your criteria.",
    });
  } catch (error) {
    console.error("Error in searchProducts:", error);
    return res.status(500).json({ message: error.message });
  }
};