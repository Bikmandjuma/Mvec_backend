const Translation = require("../models/Translation");

// @desc    Retrieve all translation keys and full multi-lang mappings for Admin
// @route   GET /api/admin/translations
// @access  Private (Admin)
exports.getAdminTranslations = async (req, res) => {
  try {
    const { module, search, page = 1, limit = 50 } = req.query;

    const filter = {};
    if (module) filter.module = module;
    if (search) {
      filter.$or = [
        { key: { $regex: search, $options: "i" } },
        { "translations.en": { $regex: search, $options: "i" } },
        { "translations.rw": { $regex: search, $options: "i" } },
        { "translations.fr": { $regex: search, $options: "i" } },
      ];
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(parseInt(limit, 10) || 50, 200);
    const skip = (pageNum - 1) * limitNum;

    const [translations, total] = await Promise.all([
      Translation.find(filter).sort({ key: 1 }).skip(skip).limit(limitNum),
      Translation.countDocuments(filter),
    ]);

    return res.status(200).json({
      meta: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
      },
      translations,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Upsert (Create/Update) a translation key mapping
// @route   POST /api/admin/translations
// @access  Private (Admin)
exports.upsertTranslationKey = async (req, res) => {
  try {
    const { key, module, translations } = req.body;

    if (!key || !translations || !translations.en || !translations.rw || !translations.fr) {
      return res.status(400).json({
        message: "Key and translations for 'en', 'rw', and 'fr' are all required.",
      });
    }

    const updatedTranslation = await Translation.findOneAndUpdate(
      { key },
      {
        key,
        module: module || "common",
        translations,
      },
      { upsert: true, new: true, runValidators: true }
    );

    return res.status(200).json({
      message: "Translation key saved successfully",
      translation: updatedTranslation,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};  