// Commission rules and the settings that divide the commission.
//
// Which rate applies to a sale (most specific wins, then higher priority,
// then the newest rule):
//   1. a seller override for that seller in that category
//   2. a seller override for that seller (all categories)
//   3. the category rate
//   4. the default rate (a GLOBAL rule, or the setting below)
//
// Settings (admin-editable, stored in platform_settings):
//   defaultCommissionPercent  rate when no rule matches
//   developerSharePercent     % of the commission paid to the developer
//   affiliateSharePercent     % of the commission paid to the affiliate
//   gatewayFeePayer           MVEC (out of the commission) or SELLER (out of the seller's share)
//   defaultWholesaleCommissionPercent  rate on supplier → vendor orders when no wholesale rule matches
//
// Rules have a scope: RETAIL (buyer orders; targetVendor = seller) or
// WHOLESALE (supplier → vendor orders; targetVendor = supplier).
//
// Rules and settings are cached for a few seconds; every change clears the cache.
const CommissionRule = require("../models/CommissionRule");
const PlatformSetting = require("../models/PlatformSetting");
const {
  DEFAULT_COMMISSION_PERCENT, DEFAULT_DEVELOPER_SHARE, DEFAULT_AFFILIATE_SHARE, GATEWAY_FEE_PAYERS, computeRevenueSplit,
} = require("../config/revenueSplit");

const SETTINGS_KEY = "commission";
const DEFAULTS = {
  defaultCommissionPercent: DEFAULT_COMMISSION_PERCENT,
  developerSharePercent: DEFAULT_DEVELOPER_SHARE,
  affiliateSharePercent: DEFAULT_AFFILIATE_SHARE,
  gatewayFeePayer: "MVEC",
  defaultWholesaleCommissionPercent: 0,
};
const MAX_RATE = 50;
const CACHE_MS = 15000;
const idOf = (v) => (v ? String(v._id || v) : "");
const httpError = (status, message) => Object.assign(new Error(message), { statusCode: status });

let cache = { settings: null, rules: null, at: 0 };
const clearCache = () => { cache = { settings: null, rules: null, at: 0 }; };
const fresh = () => Date.now() - cache.at < CACHE_MS;

async function getSettings() {
  if (cache.settings && fresh()) return cache.settings;
  const row = await PlatformSetting.findOne({ settingKey: SETTINGS_KEY }).lean();
  cache.settings = { ...DEFAULTS, ...(row?.value || {}) };
  cache.at = Date.now();
  return cache.settings;
}

async function updateSettings(patch = {}, adminId = null) {
  const next = { ...(await getSettings()) };
  const num = (key, max) => {
    if (patch[key] === undefined) return;
    const v = Number(patch[key]);
    if (!Number.isFinite(v) || v < 0 || v > max) throw httpError(400, `${key} must be between 0 and ${max}.`);
    next[key] = Math.round(v * 100) / 100;
  };
  num("defaultCommissionPercent", MAX_RATE);
  num("defaultWholesaleCommissionPercent", MAX_RATE);
  num("developerSharePercent", 100);
  num("affiliateSharePercent", 100);
  if (patch.gatewayFeePayer !== undefined) {
    if (!GATEWAY_FEE_PAYERS.includes(patch.gatewayFeePayer)) throw httpError(400, "Choose who pays payment provider fees: MVEC or the seller.");
    next.gatewayFeePayer = patch.gatewayFeePayer;
  }
  if (next.developerSharePercent + next.affiliateSharePercent > 100) {
    throw httpError(400, "The developer and affiliate shares together cannot be more than 100% of the commission.");
  }
  await PlatformSetting.findOneAndUpdate(
    { settingKey: SETTINGS_KEY },
    { $set: { settingKey: SETTINGS_KEY, value: next, updatedBy: adminId } },
    { upsert: true, new: true },
  );
  clearCache();
  return getSettings();
}

async function activeRules() {
  if (cache.rules && fresh()) return cache.rules;
  cache.rules = await CommissionRule.find({ isActive: true, rateType: "PERCENTAGE" }).lean();
  cache.at = cache.at || Date.now();
  return cache.rules;
}

const specificity = (rule, { vendorId, categoryId }) => {
  const vendor = idOf(rule.targetVendor);
  const category = idOf(rule.targetCategory);
  if (rule.ruleType === "VENDOR" && vendor === vendorId) {
    if (category) return category === categoryId ? 4 : -1;
    return 3;
  }
  if (rule.ruleType === "CATEGORY" && category && category === categoryId) return 2;
  if (rule.ruleType === "GLOBAL") return 1;
  return -1;
};
const SOURCES = { 4: "Seller override for this category", 3: "Seller override", 2: "Category rate", 1: "Default rule" };

/** The commission that applies to a sale by `vendorId` (seller, or supplier for wholesale) in `categoryId`. */
async function resolveRate({ vendorId, categoryId, scope = "RETAIL" }) {
  const ctx = { vendorId: idOf(vendorId), categoryId: idOf(categoryId) };
  const [settings, rules] = await Promise.all([getSettings(), activeRules()]);
  let best = null;
  let bestScore = 0;
  for (const rule of rules) {
    if ((rule.scope || "RETAIL") !== scope) continue;
    const score = specificity(rule, ctx);
    if (score <= 0) continue;
    const better = !best || score > bestScore
      || (score === bestScore && (rule.priority > best.priority
        || (rule.priority === best.priority && new Date(rule.updatedAt || rule.createdAt) > new Date(best.updatedAt || best.createdAt))));
    if (better) { best = rule; bestScore = score; }
  }
  if (!best) return { percent: scope === "WHOLESALE" ? settings.defaultWholesaleCommissionPercent : settings.defaultCommissionPercent, rule: null, source: scope === "WHOLESALE" ? "Default wholesale rate" : "Default rate" };
  return { percent: Number(best.rateValue), rule: best, source: SOURCES[bestScore] };
}

/** Full split for one order line, using the current rules and settings. */
async function splitFor({ vendorId, categoryId, grossTotal, hasAffiliate, gatewayFee = 0, vendorAffiliatePercent = 0, scope = "RETAIL" }) {
  const [settings, rate] = await Promise.all([getSettings(), resolveRate({ vendorId, categoryId, scope })]);
  const split = computeRevenueSplit({
    grossTotal, hasAffiliate, gatewayFee, vendorAffiliatePercent,
    commissionPercent: rate.percent,
    developerSharePercent: settings.developerSharePercent,
    affiliateSharePercent: settings.affiliateSharePercent,
    gatewayFeePayer: settings.gatewayFeePayer,
  });
  return { ...split, rule: rate.rule, source: rate.source };
}

/** The affiliate's MVEC-paid part, as a % of the sale, for this seller/category. */
async function platformAffiliatePercent({ vendorId, categoryId }) {
  const [settings, rate] = await Promise.all([getSettings(), resolveRate({ vendorId, categoryId })]);
  return Math.round(rate.percent * settings.affiliateSharePercent) / 100;
}

// ─── Admin rule management ─────────────────────────────────────────────────
async function validateRule(input, existing = null) {
  const Category = require("../models/Category");
  const User = require("../models/User");
  const ruleType = input.ruleType ?? existing?.ruleType;
  const scope = input.scope ?? existing?.scope ?? "RETAIL";
  if (!["RETAIL", "WHOLESALE"].includes(scope)) throw httpError(400, "Choose retail or wholesale.");
  if (!["GLOBAL", "CATEGORY", "VENDOR"].includes(ruleType)) throw httpError(400, "Choose a rule type: default, category or seller.");
  const rateValue = Number(input.rateValue ?? existing?.rateValue);
  if (!Number.isFinite(rateValue) || rateValue < 0 || rateValue > MAX_RATE) throw httpError(400, `The commission must be between 0% and ${MAX_RATE}%.`);
  const targetCategory = input.targetCategory !== undefined ? input.targetCategory || null : idOf(existing?.targetCategory) || null;
  const targetVendor = input.targetVendor !== undefined ? input.targetVendor || null : idOf(existing?.targetVendor) || null;
  if (ruleType === "CATEGORY" && !targetCategory) throw httpError(400, "Choose the category this rate is for.");
  if (ruleType === "VENDOR" && !targetVendor) throw httpError(400, scope === "WHOLESALE" ? "Choose the supplier this override is for." : "Choose the seller this override is for.");
  if (targetCategory && !(await Category.exists({ _id: targetCategory }))) throw httpError(400, "That category does not exist.");
  if (targetVendor && !(await User.exists({ _id: targetVendor, role: { $in: scope === "WHOLESALE" ? ["supplier"] : ["vendor", "super_admin"] } }))) throw httpError(400, scope === "WHOLESALE" ? "That supplier does not exist." : "That seller does not exist.");
  const priority = Math.round(Number(input.priority ?? existing?.priority ?? 0)) || 0;
  const name = String(input.name ?? existing?.name ?? "").trim() || `${ruleType === "GLOBAL" ? "Default" : ruleType === "CATEGORY" ? "Category" : "Seller"} rate ${rateValue}%`;
  return {
    name: name.slice(0, 150), ruleType, scope, rateType: "PERCENTAGE", rateValue, priority,
    targetCategory: ruleType === "GLOBAL" ? null : targetCategory,
    targetVendor: ruleType === "VENDOR" ? targetVendor : null,
    targetProduct: null,
    ...(input.isActive !== undefined ? { isActive: Boolean(input.isActive) } : {}),
  };
}

async function createRule(input) {
  const rule = await CommissionRule.create(await validateRule(input));
  clearCache();
  return rule;
}

async function updateRule(id, input) {
  const rule = await CommissionRule.findById(id);
  if (!rule) throw httpError(404, "Commission rule not found.");
  Object.assign(rule, await validateRule(input, rule));
  await rule.save();
  clearCache();
  return rule;
}

async function setActive(id, isActive) {
  const rule = await CommissionRule.findById(id);
  if (!rule) throw httpError(404, "Commission rule not found.");
  rule.isActive = isActive === undefined ? !rule.isActive : Boolean(isActive);
  await rule.save();
  clearCache();
  return rule;
}

async function deleteRule(id) {
  const rule = await CommissionRule.findById(id);
  if (!rule) throw httpError(404, "Commission rule not found.");
  await rule.deleteOne();
  clearCache();
}

/** Every category with the rate a seller pays there (for the seller's own view). */
async function ratesForSeller(vendorId) {
  const Category = require("../models/Category");
  const [categories, settings, fallback] = await Promise.all([
    Category.find({ active: { $ne: false } }).select("name").sort({ name: 1 }).lean(),
    getSettings(),
    resolveRate({ vendorId, categoryId: null }),
  ]);
  const rows = [];
  for (const c of categories) {
    const r = await resolveRate({ vendorId, categoryId: c._id });
    rows.push({ categoryId: idOf(c), category: c.name, percent: r.percent, source: r.source });
  }
  return { defaultPercent: fallback.percent, defaultSource: fallback.source, gatewayFeePayer: settings.gatewayFeePayer, categories: rows };
}

module.exports = {
  DEFAULTS, MAX_RATE, getSettings, updateSettings, resolveRate, splitFor, platformAffiliatePercent,
  createRule, updateRule, setActive, deleteRule, ratesForSeller, clearCache,
};
