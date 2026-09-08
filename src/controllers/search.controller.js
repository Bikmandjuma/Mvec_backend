const Product = require("../models/Product");
const Vendor = require("../models/Vendor");
const Category = require("../models/Category");
const mongoose = require("mongoose");

// Resolve a category that may be an ObjectId, slug or human-readable name
const resolveCategory = async (value) => {
  if (!value) return null;
  const matchId = mongoose.Types.ObjectId.isValid(value)
    ? { _id: new mongoose.Types.ObjectId(value) }
    : null;
  const doc = await Category.findOne({
    $or: matchId
      ? [matchId, { slug: value }, { name: value }]
      : [{ slug: value }, { name: value }],
  }).select("_id name slug");
  return doc || null;
};

// Rank a product against a query. Lower score = more relevant.
function scoreProduct(p, query) {
  const s = query.toLowerCase().trim();
  const terms = s.split(/\s+/).filter(Boolean);
  const name = (p.name || "").toLowerCase();
  const brand = (p.brand || "").toLowerCase();
  const sku = (p.sku || "").toLowerCase();
  const vendorName = ((p.vendor && (p.vendor.companyName || p.vendor.Fullname)) || "").toLowerCase();
  const categoryName = ((p.category && p.category.name) || "").toLowerCase();
  const description = (p.description || "").toLowerCase();

  const hasAllTerms = (str) => terms.length > 0 && terms.every((t) => str.includes(t));

  if (name === s) return 0;                   // exact name match
  if (name.startsWith(s)) return 1;           // name starts with query
  if (name.includes(s)) return 2;             // name contains query
  if (hasAllTerms(name)) return 3;            // all terms in name
  if (brand === s || brand.includes(s)) return 4;
  if (sku.includes(s)) return 5;
  if (categoryName.includes(s) || categoryName.includes(terms[0])) return 6;
  if (vendorName.includes(s)) return 7;
  if (description.includes(s) || hasAllTerms(description)) return 8;
  return Infinity;                            // no match
}

// @desc    Main paginated search with relevance ranking + related products
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
      includeRelated = "true",
    } = req.query;

    // Resolve category by id/slug/name so filters always work
    const resolvedCategory = category ? await resolveCategory(category) : null;

    const filter = { status: "ACTIVE" };
    if (resolvedCategory) {
      filter.category = resolvedCategory._id;
    } else if (category) {
      // Category requested but not found -> return empty result set
      return res.status(200).json({
        meta: { total: 0, page: 1, limit: Number(limit), pages: 0 },
        products: [],
        related: [],
      });
    }

    if (vendor) {
      const matchId = mongoose.Types.ObjectId.isValid(vendor);
      if (matchId) filter.vendor = vendor;
      else {
        const matchedVendor = await Vendor.findOne({
          $or: [{ slug: vendor }, { businessName: vendor }, { companyName: vendor }],
        }).select("_id");
        if (matchedVendor) filter.vendor = matchedVendor._id;
        else
          return res.status(200).json({
            meta: { total: 0, page: 1, limit: Number(limit), pages: 0 },
            products: [],
            related: [],
          });
      }
    }

    if (minPrice || maxPrice) {
      filter.price = {};
      if (minPrice) filter.price.$gte = Number(minPrice);
      if (maxPrice) filter.price.$lte = Number(maxPrice);
    }

    if (rating) {
      // Product docs may not carry a rating field; only enforce the filter when a rating exists
      const min = Number(rating);
      allMatches = allMatches.filter((p) => {
        const r = Number(p.rating || p.averageRating || p.ratingAvg || 0);
        return r > 0 ? r >= min : true;
      });
    }

    if (location) {
      const matchedVendors = await Vendor.find({
        $or: [
          { "location.city": { $regex: location, $options: "i" } },
          { "address.city": { $regex: location, $options: "i" } },
        ],
      }).select("_id");

      const vendorIds = matchedVendors.map((v) => v._id);
      filter.vendor = { $in: vendorIds };
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);

    let allMatches = await Product.find(filter)
      .populate("vendor", "companyName logoUrl address")
      .populate("category", "name slug");

    if (rating) {
      const min = Number(rating);
      allMatches = allMatches.filter((p) => {
        const r = Number(p.rating || p.averageRating || p.ratingAvg || 0);
        return r > 0 ? r >= min : true;
      });
    }

    let primary = [];
    let related = [];
    const categoriesHit = new Set();

    if (q && q.trim()) {
      const scored = allMatches
        .map((p) => ({ p, score: scoreProduct(p, q) }))
        .filter((x) => x.score !== Infinity);

      scored.sort((a, b) => a.score - b.score || (b.p.rating || 0) - (a.p.rating || 0));
      primary = scored.map((x) => x.p);
      scored.forEach((x) => x.p.category && categoriesHit.add(String(x.p.category._id)));

      // Category implied by the query itself (e.g. "iphone" -> Phones)
      const s = q.toLowerCase().trim();
      const impliedByText = allMatches.find((p) =>
        p.category && (
          p.category.name.toLowerCase().includes(s) ||
          s.split(/\s+/).every((t) => p.category.name.toLowerCase().includes(t))
        )
      );
      if (impliedByText) categoriesHit.add(String(impliedByText.category._id));
    } else {
      primary = allMatches;
    }

    // Apply explicit sort on primary results
    if (sort === "price_asc") primary.sort((a, b) => a.price - b.price);
    else if (sort === "price_desc") primary.sort((a, b) => b.price - a.price);
    else if (sort === "rating") primary.sort((a, b) => (b.rating || b.averageRating || 0) - (a.rating || a.averageRating || 0));

    const total = primary.length;
    const skip = (pageNum - 1) * limitNum;
    const pageProducts = primary.slice(skip, skip + limitNum);

    // Related products: same categories as primary matches, not already shown
    if (includeRelated !== "false" && q && q.trim() && pageNum === 1) {
      const primaryIds = new Set(pageProducts.map((p) => String(p._id)));
      related = allMatches
        .filter((p) => p.category && categoriesHit.has(String(p.category._id)) && !primaryIds.has(String(p._id)))
        .slice(0, 8);
    }

    return res.status(200).json({
      meta: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
        query: q || "",
        category: resolvedCategory ? resolvedCategory.name : category || "",
      },
      products: pageProducts,
      related,
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
        .select("name media price slug brand category")
        .populate("category", "name slug")
        .limit(20),
      Category.find({ $or: [{ name: regex }, { slug: regex }], active: true })
        .select("name slug")
        .limit(5),
      Vendor.find({ $or: [{ companyName: regex }, { businessName: regex }], status: "ACTIVE" })
        .select("companyName businessName logoUrl slug")
        .limit(3),
    ]);

    // Rank products: exact name match first, then prefix, then substring
    const ranked = products
      .map((p) => {
        const name = (p.name || "").toLowerCase();
        const s = q.toLowerCase().trim();
        let score = 99;
        if (name === s) score = 0;
        else if (name.startsWith(s)) score = 1;
        else if (name.includes(s)) score = 2;
        else score = 3;
        return { p, score };
      })
      .sort((a, b) => a.score - b.score)
      .slice(0, 6)
      .map((x) => x.p);

    return res.status(200).json({
      suggestions: {
        products: ranked,
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