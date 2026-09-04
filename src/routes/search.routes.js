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

module.exports = router;