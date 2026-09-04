const Product = require("../models/Product");
const Vendor = require("../models/Vendor");
const Category = require("../models/Category");

// @desc    Main paginated search with full filters
// @route   GET /api/search
// @access  Public
exports.search = async (req, res) => {
  try {
    const {
      q,
      category,
      vendor,
      minPrice,
      maxPrice,
      rating,
      location,
      sort,
      page = 1,
      limit = 20,
    } = req.query;

    const filter = { status: "ACTIVE" };

    // 1. Text Search
    if (q) {
      filter.$text = { $search: q };
    }

    // 2. Category & Vendor Filters
    if (category) filter.category = category;
    if (vendor) filter.vendor = vendor;

    // 3. Price Filter
    if (minPrice || maxPrice) {
      filter.price = {};
      if (minPrice) filter.price.$gte = Number(minPrice);
      if (maxPrice) filter.price.$lte = Number(maxPrice);
    }

    // 4. Rating Filter
    if (rating) {
      filter.averageRating = { $gte: Number(rating) };
    }

    // 5. Vendor Location Filtering (Lookup matched vendors)
    if (location) {
      const matchedVendors = await Vendor.find({
        "address.city": { $regex: location, $options: "i" },
      }).select("_id");
      
      const vendorIds = matchedVendors.map((v) => v._id);
      filter.vendor = { $in: vendorIds };
    }

    // 6. Sorting logic
    let sortOptions = {};
    if (q && !sort) {
      sortOptions = { score: { $meta: "textScore" } };
    } else if (sort === "price_asc") {
      sortOptions = { price: 1 };
    } else if (sort === "price_desc") {
      sortOptions = { price: -1 };
    } else if (sort === "rating") {
      sortOptions = { averageRating: -1 };
    } else {
      sortOptions = { createdAt: -1 };
    }

    // 7. Pagination
    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);
    const skip = (pageNum - 1) * limitNum;

    const projection = q ? { score: { $meta: "textScore" } } : {};

    const [products, total] = await Promise.all([
      Product.find(filter, projection)
        .sort(sortOptions)
        .skip(skip)
        .limit(limitNum)
        .populate("vendor", "companyName logoUrl address")
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
      products,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Fast auto-complete / search suggestions
// @route   GET /api/search/suggestions
// @access  Public
exports.getSuggestions = async (req, res) => {
  try {
    const { q } = req.query;

    if (!q || q.trim().length < 2) {
      return res.status(200).json({ suggestions: { products: [], categories: [], vendors: [] } });
    }

    const regex = new RegExp(q, "i");

    const [products, categories, vendors] = await Promise.all([
      Product.find({ name: regex, status: "ACTIVE" })
        .select("name media price slug")
        .limit(5),
      Category.find({ name: regex })
        .select("name slug")
        .limit(3),
      Vendor.find({ companyName: regex, status: "ACTIVE" })
        .select("companyName logoUrl slug")
        .limit(3),
    ]);

    return res.status(200).json({
      suggestions: {
        products,
        categories,
        vendors,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Aggregated Home Feed Data
// @route   GET /api/home
// @access  Public
exports.getHomeFeed = async (req, res) => {
  try {
    const [categories, featuredProducts, topVendors] = await Promise.all([
      Category.find({ isFeatured: true }).limit(8),
      Product.find({ status: "ACTIVE" })
        .sort({ averageRating: -1, createdAt: -1 })
        .limit(10)
        .populate("vendor", "companyName logoUrl"),
      Vendor.find({ verificationStatus: "VERIFIED", status: "ACTIVE" })
        .limit(6)
        .select("companyName logoUrl bannerUrl rating"),
    ]);

    return res.status(200).json({
      feed: {
        categories,
        featuredProducts,
        topVendors,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};