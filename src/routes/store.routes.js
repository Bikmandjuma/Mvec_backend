const express = require("express");
const router = express.Router();

const {
  createStore,
  getMyStore,
  updateMyStore,
  getPublicStoreBySlug,
} = require("../controllers/store.controller");

const { protect, authorize } = require("../middleware/auth.middleware");

// Public route for Marketplace shoppers
router.get("/public/:slug", getPublicStoreBySlug);

// Vendor-protected routes
router.use(protect);
router.post("/", authorize("vendor"), createStore);
router.get("/mine", authorize("vendor"), getMyStore);
router.put("/mine", authorize("vendor"), updateMyStore);

module.exports = router;