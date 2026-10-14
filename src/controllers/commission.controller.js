// Commission rules (per category, with optional per-seller overrides) and the
// settings that divide the commission. All logic lives in commission.service.
const CommissionRule = require("../models/CommissionRule");
const commission = require("../services/commission.service");
const orm = require("../database/orm");

const send = (res, error) => res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Could not save the commission rule. Please try again." });
const validId = (res, id) => (orm.isValidObjectId(id) ? true : (res.status(400).json({ message: "A valid rule id is required." }), false));

// @route GET /api/admin/commissions — rules with their targets, plus the settings.
exports.getCommissionRules = async (_req, res) => {
  try {
    const [rules, settings] = await Promise.all([
      CommissionRule.find({ ruleType: { $in: ["GLOBAL", "CATEGORY", "VENDOR"] } })
        .populate("targetCategory", "name").populate("targetVendor", "Fullname companyName email")
        .sort({ isActive: -1, ruleType: 1, priority: -1, createdAt: -1 }).lean(),
      commission.getSettings(),
    ]);
    const Vendor = require("../models/Vendor");
    const targets = rules.map((r) => r.targetVendor?._id).filter(Boolean);
    const [stores, suppliers] = await Promise.all([
      Vendor.find({ user: { $in: targets } }).select("user businessName").lean(),
      require("../models/Supplier").find({ user: { $in: targets } }).select("user businessName").lean(),
    ]);
    const storeOf = new Map([...stores, ...suppliers].map((v) => [String(v.user), v.businessName]));
    return res.json({
      success: true,
      count: rules.length,
      settings,
      maxRate: commission.MAX_RATE,
      rules: rules.map((r) => ({
        ...r,
        id: String(r._id),
        categoryName: r.targetCategory?.name || "",
        sellerName: r.targetVendor ? storeOf.get(String(r.targetVendor._id)) || r.targetVendor.companyName || r.targetVendor.Fullname : "",
      })),
    });
  } catch (error) {
    return send(res, error);
  }
};

// @route POST /api/admin/commissions
exports.createCommissionRule = async (req, res) => {
  try {
    const rule = await commission.createRule(req.body || {});
    return res.status(201).json({ success: true, message: "Commission rule created. It applies to new orders from now on.", rule });
  } catch (error) {
    return send(res, error);
  }
};

// @route PUT /api/admin/commissions/:id
exports.updateCommissionRule = async (req, res) => {
  if (!validId(res, req.params.id)) return undefined;
  try {
    const rule = await commission.updateRule(req.params.id, req.body || {});
    return res.json({ success: true, message: "Rule saved. Orders already paid keep the rate they had.", rule });
  } catch (error) {
    return send(res, error);
  }
};

// @route PATCH /api/admin/commissions/:id/toggle  (body { isActive } optional)
exports.toggleCommissionRule = async (req, res) => {
  if (!validId(res, req.params.id)) return undefined;
  try {
    const rule = await commission.setActive(req.params.id, req.body?.isActive);
    return res.json({ message: `Rule ${rule.isActive ? "activated" : "deactivated"}.`, rule });
  } catch (error) {
    return send(res, error);
  }
};

// @route DELETE /api/admin/commissions/:id
exports.deleteCommissionRule = async (req, res) => {
  if (!validId(res, req.params.id)) return undefined;
  try {
    await commission.deleteRule(req.params.id);
    return res.json({ message: "Rule deleted." });
  } catch (error) {
    return send(res, error);
  }
};

// @route GET|PUT /api/admin/commission-settings
exports.getSettings = async (_req, res) => {
  try { return res.json({ settings: await commission.getSettings() }); } catch (error) { return send(res, error); }
};
exports.updateSettings = async (req, res) => {
  try {
    const settings = await commission.updateSettings(req.body || {}, req.user?._id || req.user?.id);
    return res.json({ message: "Commission settings saved. They apply to new orders from now on.", settings });
  } catch (error) {
    return send(res, error);
  }
};

// @route GET /api/admin/commissions/preview?vendorId=&categoryId=&amount=&affiliate=1&gatewayFee=
// What one sale would look like under the current rules.
exports.previewSplit = async (req, res) => {
  try {
    const amount = Math.max(0, Number(req.query.amount) || 100000);
    const split = await commission.splitFor({
      vendorId: req.query.vendorId || null,
      categoryId: req.query.categoryId || null,
      grossTotal: amount,
      hasAffiliate: req.query.affiliate === "1" || req.query.affiliate === "true",
      gatewayFee: Math.max(0, Number(req.query.gatewayFee) || 0),
      vendorAffiliatePercent: Math.max(0, Number(req.query.sellerAffiliatePercent) || 0),
      scope: req.query.scope === "WHOLESALE" ? "WHOLESALE" : "RETAIL",
    });
    return res.json({ amount, ...split, rule: split.rule ? { id: String(split.rule._id), name: split.rule.name } : null });
  } catch (error) {
    return send(res, error);
  }
};

// @route GET /api/vendors/me/fees — the seller's own rates by category.
exports.getMyFees = async (req, res) => {
  try {
    return res.json(await commission.ratesForSeller(req.vendorId || req.user._id || req.user.id));
  } catch (error) {
    return send(res, error);
  }
};
