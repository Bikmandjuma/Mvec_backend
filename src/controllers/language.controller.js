const Translation = require("../models/Translation");

// Supported system languages
const SUPPORTED_LANGUAGES = [
  { code: "en", name: "English", flag: "🇬🇧", isDefault: true },
  { code: "rw", name: "Kinyarwanda", flag: "🇷🇼", isDefault: false },
  { code: "fr", name: "Français", flag: "🇫🇷", isDefault: false },
];

// @desc    Get supported languages & active dictionary keys for client app
// @route   GET /api/languages
// @access  Public
exports.getLanguages = async (req, res) => {
  try {
    const { lang = "en", module } = req.query;

    const targetLang = ["en", "rw", "fr"].includes(lang) ? lang : "en";

    const filter = { isApproved: true };
    if (module) filter.module = module;

    const items = await Translation.find(filter).select("key module translations");

    // Format into a key-value dictionary for frontend i18n libraries (e.g., i18next)
    const dictionary = {};
    items.forEach((item) => {
      dictionary[item.key] = item.translations[targetLang] || item.translations.en;
    });

    return res.status(200).json({
      supportedLanguages: SUPPORTED_LANGUAGES,
      currentLanguage: targetLang,
      dictionary,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};