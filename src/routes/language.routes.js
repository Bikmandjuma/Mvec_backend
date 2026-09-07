const express = require("express");
const router = express.Router();
const { getLanguages } = require("../controllers/language.controller");

router.get("/", getLanguages);

module.exports = router;