const express = require("express");
const router = express.Router();
const {
  search,
  getSuggestions,
  getHomeFeed,
} = require("../controllers/search.controller");

// Dedicated discovery routes
router.get("/", search);
router.get("/suggestions", getSuggestions);
router.get("/home", getHomeFeed);
// Portal header search (signed in, results depend on role / staff access).
router.get("/portal", require("../middleware/auth.middleware").protect, require("../controllers/portalSearch.controller").portalSearch);

module.exports = router;