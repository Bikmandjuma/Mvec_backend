const express = require("express");
const router = express.Router();
const { listLiveAdvertisements } = require("../controllers/monetization.controller");

// Public: approved, live ad placements for storefront slots.
router.get("/", listLiveAdvertisements); // GET /api/advertisements?placement=HOMEPAGE_HERO

module.exports = router;
