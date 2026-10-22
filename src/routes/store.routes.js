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

const { protect, authorize, requireOnboarded } = require("../middleware/auth.middleware");

// A new banner or new social links are Premium branding (only while plans
// are on). Saving a store that keeps its current branding is always allowed.
const brandingGuard = async (req, res, next) => {
  try {
    const plans = require("../services/plans.service");
    const ent = await plans.entitlements(req.user?.id);
    if (ent.features.storeBranding) return next();
    const Store = require("../models/Store");
    const owner = req.vendorId || req.user.id;
    const current = req.params.id
      ? await Store.findOne({ _id: req.params.id, vendor: owner }).lean()
      : await Store.findOne({ vendor: owner, isPrimary: true }).lean();
    const norm = (v) => JSON.stringify(Object.fromEntries(Object.entries(v || {}).filter(([, x]) => String(x || "").trim()).sort()));
    const bannerChanged = req.body?.banner !== undefined && String(req.body.banner || "") !== String(current?.banner || "") && String(req.body.banner || "").trim();
    const linksChanged = req.body?.socialLinks !== undefined && norm(req.body.socialLinks) !== norm(current?.socialLinks) && norm(req.body.socialLinks) !== "{}";
    if (!bannerChanged && !linksChanged) return next();
    const err = plans.upgradeError("storeBranding");
    return res.status(err.statusCode).json({ message: err.message, code: err.code, feature: "storeBranding" });
  } catch (error) {
    return next(error);
  }
};
const { checkStaffPermission } = require("../middleware/staff.middleware");

// Public route for Marketplace shoppers
router.get("/public/:slug", getPublicStoreBySlug);

// Vendor-protected routes
router.use(protect);
// Store management. Changing stores needs the settings permission for staff.
router.post("/", authorize("vendor"), checkStaffPermission("canManageSettings"), createStore);
router.get("/mine", authorize("vendor"), getMyStore);        // all stores + primary
router.put("/mine", authorize("vendor"), checkStaffPermission("canManageSettings"), brandingGuard, updateMyStore);     // primary store (legacy)
router.get("/mine/:id", authorize("vendor"), getMyStoreById);
router.put("/mine/:id", authorize("vendor"), checkStaffPermission("canManageSettings"), brandingGuard, updateMyStoreById);
router.patch("/mine/:id/primary", authorize("vendor"), checkStaffPermission("canManageSettings"), setPrimaryStore);
router.delete("/mine/:id", authorize("vendor"), checkStaffPermission("canManageSettings"), deleteMyStore);

module.exports = router;
