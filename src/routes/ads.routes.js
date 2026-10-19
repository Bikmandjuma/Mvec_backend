const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const advertising = require("../services/advertising.service");
const { optionalProtect } = require("../middleware/auth.middleware");
const rateLimit = require("express-rate-limit");

// A visitor is a signed-in user only when the token really verifies;
// otherwise the IP address. A made-up header can't create new visitors.
const visitorOf = (req) => {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (token) {
    try { const d = jwt.verify(token, process.env.JWT_SECRET); if (d?.userId || d?.id) return `u:${d.userId || d.id}`; } catch { /* not a valid session */ }
  }
  return `ip:${req.ip}`;
};
// Generous for real shoppers, but caps scripted clicking from one address.
const clickLimit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false, message: { message: "Too many clicks. Try again later." } });

// Buyers with an active Premium (ad-free) plan see no sponsored products.
async function isAdFree(req) {
  if (!req.user || req.user.role !== "buyer") return false;
  const BuyerSubscription = require("../models/BuyerSubscription");
  const sub = await BuyerSubscription.findOne({ buyer: req.user.id }).lean();
  return Boolean(sub && sub.plan === "PREMIUM" && sub.status === "ACTIVE" && sub.renewalDate && new Date(sub.renewalDate) > new Date());
}

// ─── PUBLIC SPONSORED PRODUCTS ──────────────────────────────────────────────
// GET  /api/ads/sponsored?surface=home|search|category|shop&q=&category=&limit=&exclude=id,id
// POST /api/ads/:id/click   → counts the click (charged per click) and returns the product id
router.get("/sponsored", optionalProtect, async (req, res) => {
  try {
    if (await isAdFree(req)) return res.status(200).json({ data: [], adFree: true });
    const { surface, q, category } = req.query;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 4, 1), 12);
    const exclude = String(req.query.exclude || "").split(",").filter(Boolean);
    const items = await advertising.serve({ surface, q, category, limit, exclude });
    return res.status(200).json({ data: items });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

router.post("/:id/click", clickLimit, async (req, res) => {
  try {
    const visitor = visitorOf(req);
    const result = await advertising.click(req.params.id, visitor);
    return res.status(200).json({ productId: result.productId });
  } catch (error) {
    return res.status(error.status || 500).json({ message: error.message });
  }
});

module.exports = router;
