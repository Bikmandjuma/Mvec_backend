const express = require("express");
const router = express.Router();
const review = require("../controllers/review.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// ─── PUBLIC ──────────────────────────────────────────────────────────────────
router.get("/product/:productId", review.listProductReviews);

// ─── AUTHENTICATED ────────────────────────────────────────────────────────────
router.use(protect);

router.post("/", review.createReview);
router.get("/mine", review.listMyReviews);
router.patch("/:id", review.updateReview);
router.delete("/:id", review.deleteReview);

// ─── VENDOR ───────────────────────────────────────────────────────────────────
router.get("/vendor/mine", authorize("vendor"), review.listVendorReviews);

// ─── ADMIN ────────────────────────────────────────────────────────────────────
router.get("/", authorize("super_admin"), review.adminListReviews);

module.exports = router;
