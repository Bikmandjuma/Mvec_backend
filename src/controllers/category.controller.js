const mongoose = require("mongoose");
const Category = require("../models/Category");
const Product = require("../models/Product");

// Helper: turn a name into a slug
const slugify = (str) =>
  str
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

// ─── CREATE CATEGORY ──────────────────────────────────────────────────────
// @route   POST /api/categories        (admin, or /api/vendor/categories if permitted)
exports.createCategory = async (req, res) => {
  try {
    const { name, description, imageUrl, sortOrder, parentId } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Category name is required" });
    }

    // Validate parent exists if provided
    let parent = null;
    if (parentId) {
      if (!mongoose.Types.ObjectId.isValid(parentId)) {
        return res.status(400).json({ message: "Invalid parentId" });
      }
      parent = await Category.findById(parentId);
      if (!parent) {
        return res.status(404).json({ message: "Parent category not found" });
      }
    }

    // Subcategory slugs are prefixed with the parent so "Accessories" can
    // exist under both Phones and Fashion.
    const slug = parent ? `${parent.slug}-${slugify(name)}` : slugify(name);

    const existing = await Category.findOne({ slug });
    if (existing && !existing.active) {
      return res.status(409).json({ message: `"${existing.name}" was disabled by MVEC and can't be used. Choose another category.` });
    }
    if (existing) {
      // Return the existing category so the form can auto-select it rather than error
      return res.status(200).json({
        alreadyExisted: true,
        message: `Category "${existing.name}" already exists and has been selected.`,
        category: { id: existing._id, _id: existing._id, name: existing.name, slug: existing.slug, parentId: existing.parentId },
      });
    }

    const category = await Category.create({
      name: name.trim(),
      slug,
      description,
      imageUrl,
      sortOrder: sortOrder || 0,
      parentId: parentId || null,
    });

    return res.status(201).json({ message: "Category created", category });
  } catch (error) {
    console.error("Error creating category:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// ─── GET ALL CATEGORIES (flat, optionally nested tree) ────────────────────
// @route   GET /api/categories?tree=true&withCounts=true
// withCounts adds productCount (active marketplace products) to each category.
exports.getCategories = async (req, res) => {
  try {
    let categories = await Category.find({ active: true }).sort({ sortOrder: 1, name: 1 });

    if (req.query.withCounts === "true") {
      const rows = await Product.aggregate([
        { $match: { status: "ACTIVE", category: { $in: categories.map((c) => c._id) } } },
        { $group: { _id: "$category", count: { $sum: 1 } } },
      ]);
      const counts = Object.fromEntries(rows.map((r) => [String(r._id), r.count]));
      categories = categories.map((c) => ({ ...c.toJSON(), productCount: counts[String(c._id)] || 0 }));
    }

    if (req.query.tree === "true") {
      const byId = {};
      categories.forEach((cat) => {
        const plain = typeof cat.toJSON === "function" ? cat.toJSON() : cat;
        byId[cat._id] = { ...plain, children: [] };
      });

      const tree = [];
      categories.forEach((cat) => {
        if (cat.parentId) {
          byId[cat.parentId]?.children.push(byId[cat._id]);
        } else {
          tree.push(byId[cat._id]);
        }
      });

      return res.status(200).json({ categories: tree });
    }

    return res.status(200).json({ categories });
  } catch (error) {
    console.error("Error fetching categories:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// ─── GET SINGLE CATEGORY BY SLUG ───────────────────────────────────────────
// @route   GET /api/categories/:slug
exports.getCategoryBySlug = async (req, res) => {
  try {
    const category = await Category.findOne({ slug: req.params.slug, active: true });
    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    const subcategories = await Category.find({ parentId: category._id, active: true });

    return res.status(200).json({ category, subcategories });
  } catch (error) {
    console.error("Error fetching category:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// ─── UPDATE CATEGORY ────────────────────────────────────────────────────────
// @route   PATCH /api/admin/categories/:id
exports.updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, imageUrl, sortOrder, active, parentId } = req.body;

    const category = await Category.findById(id);
    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    // Prevent a category from becoming its own parent (or a self-reference loop)
    if (parentId) {
      if (parentId === id) {
        return res.status(422).json({ message: "A category cannot be its own parent" });
      }
      if (!mongoose.Types.ObjectId.isValid(parentId)) {
        return res.status(400).json({ message: "Invalid parentId" });
      }
      const parent = await Category.findById(parentId);
      if (!parent) {
        return res.status(404).json({ message: "Parent category not found" });
      }
      category.parentId = parentId;
    } else if (parentId === null) {
      category.parentId = null;
    }

    if (name && name.trim()) {
      category.name = name.trim();
      const parentDoc = category.parentId ? await Category.findById(category.parentId) : null;
      category.slug = parentDoc ? `${parentDoc.slug}-${slugify(name)}` : slugify(name);

      const existing = await Category.findOne({ slug: category.slug, _id: { $ne: id } });
      if (existing) {
        return res.status(409).json({ message: "A category with this name/slug already exists" });
      }
    }

    if (description !== undefined) category.description = description;
    if (imageUrl !== undefined) category.imageUrl = imageUrl;
    if (sortOrder !== undefined) category.sortOrder = sortOrder;
    if (active !== undefined) category.active = Boolean(active);

    await category.save();

    return res.status(200).json({ message: "Category updated", category });
  } catch (error) {
    console.error("Error updating category:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// ─── DELETE (SOFT) CATEGORY ─────────────────────────────────────────────────
// @route   DELETE /api/admin/categories/:id
exports.deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;

    const category = await Category.findById(id);
    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    // Block delete if it still has active subcategories
    const childCount = await Category.countDocuments({ parentId: id, active: true });
    if (childCount > 0) {
      return res.status(409).json({
        message: "Cannot delete a category that still has active subcategories",
      });
    }

    // Soft-delete: keeps history/products referencing it intact
    category.active = false;
    await category.save();

    return res.status(200).json({ message: "Category disabled", category });
  } catch (error) {
    console.error("Error deleting category:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};