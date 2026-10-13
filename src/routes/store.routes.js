const express = require("express");
const router = express.Router();

const {
  createStore,
  getMyStore,
  updateMyStore,
  getMyStoreById,
  updateMyStoreById,
  setPrimaryStore,
  deleteMyStore,
  getPublicStoreBySlug,
} = require("../controllers/store.controller");

const { protect, authorize } = require("../middleware/auth.middleware");

// Public route for Marketplace shoppers
router.get("/public/:slug", getPublicStoreBySlug);

// Vendor-protected routes
router.use(protect);
router.post("/", authorize("vendor"), createStore);
router.get("/mine", authorize("vendor"), getMyStore);        // all stores + primary
router.put("/mine", authorize("vendor"), updateMyStore);     // primary store (legacy)
router.get("/mine/:id", authorize("vendor"), getMyStoreById);
router.put("/mine/:id", authorize("vendor"), updateMyStoreById);
router.patch("/mine/:id/primary", authorize("vendor"), setPrimaryStore);
router.delete("/mine/:id", authorize("vendor"), deleteMyStore);

module.exports = router;
