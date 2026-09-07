const express = require("express");
const router = express.Router();
const {
  getAdminTranslations,
  upsertTranslationKey,
} = require("../controllers/adminTranslation.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// Require authentication AND Admin role
router.use(protect);
router.use(authorize("admin", "super_admin"));

router.get("/translations", getAdminTranslations);
router.post("/translations", upsertTranslationKey);

module.exports = router;