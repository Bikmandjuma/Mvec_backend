const express = require("express");
const router = express.Router();
const promotion = require("../controllers/promotion.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

router.use(protect);

// Vendors manage their own promotions; admins can list/manage all.
router.get("/", promotion.listPromotions);
router.post("/", authorize("vendor", "super_admin"), promotion.createPromotion);
router.patch("/:id", promotion.updatePromotion);
router.delete("/:id", promotion.deletePromotion);

module.exports = router;
