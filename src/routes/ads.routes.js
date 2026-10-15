const express = require("express");
const router = express.Router();
const advertising = require("../services/advertising.service");

// ─── PUBLIC SPONSORED PRODUCTS ──────────────────────────────────────────────
// GET  /api/ads/sponsored?surface=home|search|category|shop&q=&category=&limit=&exclude=id,id
// POST /api/ads/:id/click   → counts the click (charged per click) and returns the product id
router.get("/sponsored", async (req, res) => {
  try {
    const { surface, q, category } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 4, 1), 12);
    const exclude = String(req.query.exclude || "").split(",").filter(Boolean);
    const items = await advertising.serve({ surface, q, category, limit, exclude });
    return res.status(200).json({ data: items });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post("/:id/click", async (req, res) => {
  try {
    const visitor = req.headers.authorization ? req.headers.authorization.slice(-24) : req.ip;
    const result = await advertising.click(req.params.id, visitor);
    return res.status(200).json({ productId: result.productId });
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message });
  }
});

module.exports = router;
