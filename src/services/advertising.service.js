// Sponsored products. The seller pays the campaign budget from their
// available balance when submitting; MVEC reviews it; once live, each buyer
// click spends AD_COST_PER_CLICK from the budget. Whatever is not spent comes
// back to the balance when the campaign is rejected, ended or runs out of time.
const Advertisement = require("../models/Advertisement");
const Vendor = require("../models/Vendor");
const orm = require("../database/orm");
const Product = require("../models/Product");
const Category = require("../models/Category");
const sellerFinance = require("./sellerFinance.service");

const MIN_BUDGET = 5000;
const COST_PER_CLICK = Number(process.env.AD_COST_PER_CLICK) || 100;
const CLICK_DEDUPE_MS = 30 * 60 * 1000;
const fmt = (n) => `${Math.round(Number(n) || 0).toLocaleString("en-RW")} RWF`;
const endOfDay = (d) => { const x = new Date(d); x.setUTCHours(23, 59, 59, 999); return x; };

// Which ad placements each storefront surface shows.
const SURFACES = {
  home: ["HOMEPAGE_HERO", "FEATURED", "PROMOTION"],
  search: ["SEARCH_RESULTS"],
  category: ["CATEGORY_BANNER", "SEARCH_RESULTS"],
  shop: ["PROMOTION", "FEATURED", "SEARCH_RESULTS"],
};

async function sellerUserOf(ad) {
  const vendor = await Vendor.findById(ad.vendor).select("user");
  return vendor?.user || null;
}

const remaining = (ad) => Math.max(0, Number(ad.budget) - Number(ad.spent || 0) - Number(ad.refunded || 0));

// Close a campaign and return what is left of the budget.
async function finish(ad, status, { reason = "", notify = true } = {}) {
  // Only return what was really taken from the seller and not spent yet: a
  // campaign whose budget was never charged gives nothing back.
  const stillReserved = Math.max(0, (await sellerFinance.netCharged(ad.publicId)) - Number(ad.spent || 0));
  const left = Math.min(remaining(ad), stillReserved);
  ad.status = status;
  if (reason) ad.rejectionReason = reason;
  ad.refunded = Number(ad.refunded || 0) + left;
  await ad.save();
  const user = await sellerUserOf(ad);
  if (user && left > 0) {
    await sellerFinance.creditBalance(user, left, {
      type: "ADVERTISING", reference: ad.publicId,
      description: `${status === "REJECTED" ? "Ad budget refunded" : "Unspent ad budget returned"} · ${ad.product}`,
    });
  }
  if (user && notify) {
    const title = status === "REJECTED" ? "Ad campaign not approved" : "Ad campaign ended";
    const message = status === "REJECTED"
      ? `Your campaign for ${ad.product} was not approved${reason ? `: ${reason}` : ""}. ${fmt(left)} is back in your balance.`
      : `Your campaign for ${ad.product} ended after ${ad.clicks} clicks. ${left > 0 ? `${fmt(left)} unspent is back in your balance.` : "The full budget was used."}`;
    await sellerFinance.notify(user, title, message, ad.publicId, "SYSTEM");
  }
  return left;
}

const isLive = (ad, now = new Date()) =>
  ad.status === "ACTIVE" && remaining(ad) >= Math.min(COST_PER_CLICK, Number(ad.budget)) &&
  (!ad.startDate || new Date(ad.startDate) <= now) && (!ad.endDate || endOfDay(ad.endDate) >= now);

// Sponsored products for a storefront surface; counts an impression for each.
async function serve({ surface = "shop", q = "", category = "", limit = 4, exclude = [] } = {}) {
  const placements = SURFACES[surface] || SURFACES.shop;
  // The storefront filters by category name; accept a name or an id.
  if (category && !orm.isValidObjectId(category)) {
    const cat = await Category.findOne({ name: category }).select("_id");
    if (!cat) return [];
    category = String(cat._id);
  }
  const ads = (await Advertisement.find({ status: "ACTIVE", placement: { $in: placements } })).filter((a) => isLive(a) && a.productId);
  if (!ads.length) return [];
  const products = await Product.find({ _id: { $in: ads.map((a) => a.productId) }, status: "ACTIVE" });
  const byId = new Map(products.filter((p) => p.stockQuantity > 0).map((p) => [String(p._id), p]));
  const term = String(q || "").trim().toLowerCase();
  const skip = new Set(exclude.map(String));
  const candidates = ads.filter((a) => {
    const p = byId.get(String(a.productId));
    if (!p || skip.has(String(p._id))) return false;
    if (category && String(p.category) !== String(category)) return false;
    if (term && !`${p.name} ${p.description || ""} ${(p.tags || []).join(" ")}`.toLowerCase().includes(term)) return false;
    return true;
  });
  // Random order weighted by remaining budget; one slot per product.
  const picked = [];
  const seen = new Set();
  const pool = candidates.map((a) => ({ a, w: Math.random() * Math.sqrt(remaining(a) + 1) })).sort((x, y) => y.w - x.w);
  for (const { a } of pool) {
    const key = String(a.productId);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(a);
    if (picked.length >= limit) break;
  }
  if (picked.length) await Advertisement.updateMany({ _id: { $in: picked.map((a) => a._id) } }, { $inc: { impressions: 1 } });
  return picked.map((a) => {
    const p = byId.get(String(a.productId));
    return { adId: a.publicId, placement: a.placement, productId: String(p._id), productPublicId: p.publicId || null, name: p.name };
  });
}

// One paid click per visitor per campaign every 30 minutes. Remembered in the
// database, so restarts or several servers can't bill the same click twice.
// `visitor` is a signed-in user id or the caller's IP (decided by the route).
async function claimClick(adId, visitor) {
  const { sequelize } = require("../database");
  const key = String(visitor || "unknown").slice(0, 80);
  await sequelize.query("INSERT IGNORE INTO ad_clicks (advertisementId, visitorKey, lastClickAt, paidClicks) VALUES (?, ?, '1970-01-02', 0)", { replacements: [String(adId), key] });
  const [result] = await sequelize.query(
    "UPDATE ad_clicks SET lastClickAt = NOW(3), paidClicks = paidClicks + 1 WHERE advertisementId = ? AND visitorKey = ? AND lastClickAt < NOW(3) - INTERVAL ? SECOND",
    { replacements: [String(adId), key, Math.round(CLICK_DEDUPE_MS / 1000)] },
  );
  return (result?.affectedRows ?? result) > 0;
}

async function click(publicId, visitor) {
  const ad = await Advertisement.findOne({ publicId });
  if (!ad) throw Object.assign(new Error("Campaign not found"), { status: 404 });
  const result = { productId: ad.productId, charged: 0 };
  if (!isLive(ad)) return result;
  if (!(await claimClick(ad._id, visitor))) return result;

  const cost = Math.min(COST_PER_CLICK, remaining(ad));
  const updated = await Advertisement.findOneAndUpdate(
    { _id: ad._id, spent: ad.spent, status: "ACTIVE" },
    { $inc: { clicks: 1, spent: cost } },
    { new: true },
  );
  if (!updated) return result;
  result.charged = cost;
  // The click is MVEC's ad revenue.
  await require("./ledger.service").mvecEarned({
    from: ["AD_BUDGETS"], amount: cost, entryType: "AD_CLICK_REVENUE",
    reference: ad.publicId, description: `Sponsored click · ${ad.product}`,
  }).catch((e) => console.error("Ad revenue not recorded:", e.message));
  if (remaining(updated) < Math.min(COST_PER_CLICK, Number(updated.budget))) await finish(updated, "COMPLETED");
  return result;
}

// Hourly: end campaigns whose end date has passed and return unspent budget.
async function sweep(now = new Date()) {
  const due = (await Advertisement.find({ status: { $in: ["ACTIVE", "PAUSED"] }, endDate: { $ne: null } }))
    .filter((a) => endOfDay(a.endDate) < now);
  for (const ad of due) await finish(ad, "COMPLETED");
  return { ended: due.length };
}

module.exports = { MIN_BUDGET, COST_PER_CLICK, SURFACES, remaining, finish, serve, click, sweep, sellerUserOf, isLive };
