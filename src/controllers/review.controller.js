const mongoose = require("mongoose");
const Review = require("../models/Review");
const Product = require("../models/Product");
const Order = require("../models/Order");

// Map DB document -> API row shape the frontend reviews tables expect.
function imageUrl(product) {
  return product?.media?.mainImage || product?.image || null;
}

function mapReview(r) {
  const product = r.product && typeof r.product === "object" ? r.product : null;
  const reviewer = r.user && typeof r.user === "object" ? r.user : null;
  return {
    id: r.publicId || r._id,
    product: product ? product.name : (r.product || null),
    productId: r.product && product ? product._id : r.product,
    productImage: imageUrl(product),
    reviewer: reviewer ? reviewer.Fullname : (r.user || null),
    user: reviewer ? reviewer.Fullname : (r.user || null),
    email: reviewer ? reviewer.email : null,
    rating: r.rating,
    review: r.reviewText,
    comment: r.reviewText,
    status: r.status || "PUBLISHED",
    date: r.createdAt,
    isVerifiedPurchase: r.isVerifiedPurchase,
  };
}

const populateOpts = [
  { path: "product", select: "name media image" },
  { path: "user", select: "Fullname email" },
];

// @desc    Create a review for a product (only for purchases by the user)
// @route   POST /api/reviews
// @access  Private (any authenticated role)
exports.createReview = async (req, res) => {
  try {
    const { product, rating, reviewText, images } = req.body;
    const userId = req.user._id;

    if (!product || !rating) {
      return res.status(400).json({ message: "Product and rating are required" });
    }
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ message: "Rating must be between 1 and 5" });
    }
    if (!mongoose.Types.ObjectId.isValid(product)) {
      return res.status(400).json({ message: "Invalid product id" });
    }

    const productDoc = await Product.findById(product);
    if (!productDoc) {
      return res.status(404).json({ message: "Product not found" });
    }

    // Require a verified purchase: an order containing this product.
    const bought = await Order.findOne({
      user: userId,
      "items.product": product,
      orderStatus: { $in: ["DELIVERED", "SHIPPED"] },
    });

    if (!bought) {
      return res.status(403).json({
        message: "You can only review products you have purchased",
      });
    }

    const existing = await Review.findOne({ user: userId, product });
    if (existing) {
      return res.status(409).json({ message: "You have already reviewed this product" });
    }

    const review = await Review.create({
      user: userId,
      product,
      parentOrder: bought._id,
      rating,
      reviewText: reviewText || "",
      images: images || [],
      isVerifiedPurchase: true,
    });

    await Review.populate(review, populateOpts);
    return res.status(201).json({
      message: "Review submitted",
      review: mapReview(review.toObject()),
    });
  } catch (error) {
    console.error("Error creating review:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// @desc    List reviews for a product
// @route   GET /api/reviews/product/:productId
// @access  Public
exports.listProductReviews = async (req, res) => {
  try {
    const { productId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({ message: "Invalid product id" });
    }

    const reviews = await Review.find({ product: productId, status: "PUBLISHED" })
      .populate(populateOpts)
      .sort({ createdAt: -1 });

    const productDoc = await Product.findById(productId).select("name");

    return res.status(200).json({
      product: productDoc?.name || null,
      count: reviews.length,
      averageRating: reviews.length
        ? (reviews.reduce((s, r) => s + r.rating, 0) / reviews.length).toFixed(1)
        : 0,
      reviews: reviews.map((r) => mapReview(r.toObject())),
    });
  } catch (error) {
    console.error("Error listing product reviews:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// @desc    List current user's reviews
// @route   GET /api/reviews/mine
// @access  Private (authenticated)
exports.listMyReviews = async (req, res) => {
  try {
    const reviews = await Review.find({ user: req.user._id })
      .populate(populateOpts)
      .sort({ createdAt: -1 });

    return res.status(200).json({
      data: reviews.map((r) => mapReview(r.toObject())),
    });
  } catch (error) {
    console.error("Error listing my reviews:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// @desc    List reviews for the vendor's own products
// @route   GET /api/reviews/vendor/mine
// @access  Private (vendor)
exports.listVendorReviews = async (req, res) => {
  try {
    const productIds = await Product.find({ vendor: req.user._id }).distinct("_id");
    const reviews = await Review.find({ product: { $in: productIds } })
      .populate(populateOpts)
      .sort({ createdAt: -1 });

    return res.status(200).json({
      data: reviews.map((r) => mapReview(r.toObject())),
    });
  } catch (error) {
    console.error("Error listing vendor reviews:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// @desc    Admin list all reviews (optional filters)
// @route   GET /api/reviews?product=&user=&status=
// @access  Private (super_admin)
exports.adminListReviews = async (req, res) => {
  try {
    const { product, user, status } = req.query;
    const query = {};
    if (product) query.product = product;
    if (user) query.user = user;
    if (status) query.status = status;

    const reviews = await Review.find(query)
      .populate(populateOpts)
      .sort({ createdAt: -1 });

    return res.status(200).json({
      data: reviews.map((r) => mapReview(r.toObject())),
      meta: { total: reviews.length },
    });
  } catch (error) {
    console.error("Error listing reviews:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// @desc    Update a review (admin: moderation status; vendor: respond flag)
// @route   PATCH /api/reviews/:id
// @access  Private (super_admin or owning vendor)
exports.updateReview = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, isVerifiedPurchase, reviewText } = req.body;

    const review = await Review.findById(id);
    if (!review) {
      return res.status(404).json({ message: "Review not found" });
    }

    if (req.user.role === "super_admin") {
      if (status !== undefined) {
        const allowed = ["PENDING", "PUBLISHED", "HIDDEN"];
        if (!allowed.includes(status)) {
          return res.status(400).json({ message: "Invalid review status" });
        }
        review.status = status;
      }
      if (isVerifiedPurchase !== undefined) review.isVerifiedPurchase = Boolean(isVerifiedPurchase);
    } else if (req.user.role === "buyer") {
      if (String(review.user) !== String(req.user._id)) {
        return res.status(403).json({ message: "You can only edit your own review" });
      }
      if (reviewText !== undefined) review.reviewText = reviewText;
    } else {
      return res.status(403).json({ message: "Not authorized to update this review" });
    }

    await review.save();
    await Review.populate(review, populateOpts);
    return res.status(200).json({
      message: "Review updated",
      review: mapReview(review.toObject()),
    });
  } catch (error) {
    console.error("Error updating review:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// @desc    Delete a review (admin only, or buyer own)
// @route   DELETE /api/reviews/:id
// @access  Private
exports.deleteReview = async (req, res) => {
  try {
    const { id } = req.params;
    const review = await Review.findById(id);
    if (!review) {
      return res.status(404).json({ message: "Review not found" });
    }

    const isBuyerOwner = req.user.role === "buyer" && String(review.user) === String(req.user._id);
    const isAdmin = req.user.role === "super_admin";
    if (!isBuyerOwner && !isAdmin) {
      return res.status(403).json({ message: "Not authorized to delete this review" });
    }

    await Review.deleteOne({ _id: id });
    return res.status(200).json({ message: "Review deleted" });
  } catch (error) {
    console.error("Error deleting review:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};
