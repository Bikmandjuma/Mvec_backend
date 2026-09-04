const mongoose = require("mongoose");

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true },
  slug: { type: String, required: true, unique: true },
  parentId: { type: mongoose.Schema.Types.ObjectId, ref: "Category", default: null }, // subcategories
  description: String,
  imageUrl: String,
  sortOrder: { type: Number, default: 0 },
  active: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model("Category", categorySchema);