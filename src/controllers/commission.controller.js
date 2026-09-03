const CommissionRule = require("../models/CommissionRule");

// @desc    Create a new dynamic commission rule
// @route   POST /api/admin/commissions
// @access  Private (Super Admin)
exports.createCommissionRule = async (req, res) => {
  try {
    const { name, ruleType, targetCategory, targetVendor, targetProduct, rateType, rateValue, priority } = req.body;

    const newRule = await CommissionRule.create({
      name,
      ruleType,
      targetCategory: targetCategory || null,
      targetVendor: targetVendor || null,
      targetProduct: targetProduct || null,
      rateType,
      rateValue,
      priority: priority || 0,
    });

    return res.status(201).json({ success: true, message: "Commission rule created successfully.", rule: newRule });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Get all commission rules
// @route   GET /api/admin/commissions
// @access  Private (Super Admin)
exports.getCommissionRules = async (req, res) => {
  try {
    const rules = await CommissionRule.find()
      .populate("targetCategory targetVendor targetProduct")
      .sort({ priority: -1 });

    return res.status(200).json({ success: true, count: rules.length, rules });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Toggle rule status (Active/Inactive)
// @route   PATCH /api/admin/commissions/:id/toggle
// @access  Private (Super Admin)
exports.toggleCommissionRule = async (req, res) => {
  try {
    const { id } = req.params;
    const rule = await CommissionRule.findById(id);

    if (!rule) return res.status(404).json({ message: "Commission rule not found." });

    rule.isActive = !rule.isActive;
    await rule.save();

    return res.status(200).json({ message: `Rule ${rule.isActive ? "activated" : "deactivated"} successfully.`, rule });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};