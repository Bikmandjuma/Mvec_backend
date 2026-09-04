const Supplier = require("../models/Supplier");

// ─── 1. ONBOARD SUPPLIER (complete profile after registering) ──────────────
// @route   POST /api/suppliers/onboard
// @access  Private (role: "supplier")
exports.onboardSupplier = async (req, res) => {
  try {
    if (req.user.role !== "supplier") {
      return res.status(403).json({ message: "Only supplier accounts can create a supplier profile" });
    }

    const existing = await Supplier.findOne({ user: req.user.id });
    if (existing) {
      return res.status(409).json({ message: "Supplier profile already exists" });
    }

    const { businessName, description, phone, email, logoUrl, location } = req.body;

    if (!businessName || !phone || !email) {
      return res.status(400).json({ message: "businessName, phone, and email are required" });
    }

    const supplier = await Supplier.create({
      user: req.user.id,
      businessName,
      description,
      phone,
      email,
      logoUrl,
      location: location || null,
    });

    return res.status(201).json({ message: "Supplier profile created", supplier });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "A supplier with this business name already exists" });
    }
    return res.status(400).json({ message: error.message });
  }
};

// ─── 2. GET OWN SUPPLIER PROFILE ────────────────────────────────────────────
// @route   GET /api/supplier/profile
// @access  Private (role: "supplier")
exports.getMyProfile = async (req, res) => {
  try {
    const supplier = await Supplier.findOne({ user: req.user.id });
    if (!supplier) {
      return res.status(404).json({ message: "Supplier profile not found. Please complete onboarding." });
    }
    return res.status(200).json({ supplier });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── 3. UPDATE OWN SUPPLIER PROFILE ─────────────────────────────────────────
// @route   PATCH /api/supplier/profile
// @access  Private (role: "supplier", own profile only)
exports.updateMyProfile = async (req, res) => {
  try {
    const supplier = await Supplier.findOne({ user: req.user.id });
    if (!supplier) {
      return res.status(404).json({ message: "Supplier profile not found. Please complete onboarding." });
    }

    const { businessName, description, phone, email, logoUrl, location } = req.body;

    // Fields the supplier is allowed to self-edit — NOT verificationStatus, ratingAvg, or status
    if (businessName !== undefined) supplier.businessName = businessName;
    if (description !== undefined) supplier.description = description;
    if (phone !== undefined) supplier.phone = phone;
    if (email !== undefined) supplier.email = email;
    if (logoUrl !== undefined) supplier.logoUrl = logoUrl;
    if (location !== undefined) supplier.location = location;

    await supplier.save();
    return res.status(200).json({ message: "Supplier profile updated", supplier });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "A supplier with this business name already exists" });
    }
    return res.status(400).json({ message: error.message });
  }
};

// ─── 4. PUBLIC SUPPLIER DIRECTORY ───────────────────────────────────────────
// @route   GET /api/suppliers?q=&category=&location=&page=&pageSize=
// @access  Public
exports.getSuppliers = async (req, res) => {
  try {
    const { q, location, page = 1, pageSize = 20 } = req.query;

    const filter = {
      status: "ACTIVE",
      verificationStatus: "VERIFIED", // only show verified suppliers publicly
    };

    if (q) {
      filter.businessName = { $regex: q, $options: "i" };
    }
    if (location) {
      filter.location = location;
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limit = Math.min(parseInt(pageSize, 10) || 20, 100); // cap page size
    const skip = (pageNum - 1) * limit;

    const [suppliers, total] = await Promise.all([
      Supplier.find(filter).sort({ ratingAvg: -1 }).skip(skip).limit(limit),
      Supplier.countDocuments(filter),
    ]);

    return res.status(200).json({
      data: suppliers,
      meta: { page: pageNum, pageSize: limit, total },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── 5. PUBLIC SUPPLIER STOREFRONT (by id or slug) ─────────────────────────
// @route   GET /api/suppliers/:idOrSlug
// @access  Public
exports.getSupplierByIdOrSlug = async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const isObjectId = idOrSlug.match(/^[0-9a-fA-F]{24}$/);

    const query = isObjectId
      ? { _id: idOrSlug }
      : { slug: idOrSlug };

    const supplier = await Supplier.findOne({
      ...query,
      status: "ACTIVE",
      verificationStatus: "VERIFIED",
    });

    if (!supplier) {
      return res.status(404).json({ message: "Supplier not found" });
    }

    // NOTE: once Product model links `supplier`, populate their products/reviews here too
    return res.status(200).json({ supplier });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── 6. ADMIN: LIST ALL SUPPLIERS (any status) ──────────────────────────────
// @route   GET /api/admin/suppliers?status=&verificationStatus=&page=&pageSize=
// @access  Private (super_admin)
exports.adminGetSuppliers = async (req, res) => {
  try {
    const { status, verificationStatus, page = 1, pageSize = 20 } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (verificationStatus) filter.verificationStatus = verificationStatus;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limit = Math.min(parseInt(pageSize, 10) || 20, 100);
    const skip = (pageNum - 1) * limit;

    const [suppliers, total] = await Promise.all([
      Supplier.find(filter).populate("user", "Fullname email phone").skip(skip).limit(limit),
      Supplier.countDocuments(filter),
    ]);

    return res.status(200).json({
      data: suppliers,
      meta: { page: pageNum, pageSize: limit, total },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── 7. ADMIN: VERIFY / REJECT SUPPLIER ─────────────────────────────────────
// @route   PATCH /api/admin/suppliers/:id/verify
// @access  Private (super_admin)
exports.adminVerifySupplier = async (req, res) => {
  try {
    const { decision } = req.body; // "VERIFIED" | "REJECTED"

    if (!["VERIFIED", "REJECTED"].includes(decision)) {
      return res.status(400).json({ message: "decision must be VERIFIED or REJECTED" });
    }

    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) {
      return res.status(404).json({ message: "Supplier not found" });
    }

    supplier.verificationStatus = decision;
    await supplier.save();

    // TODO: trigger notification to supplier (doc: "Order accepted / Payment received" style events)

    return res.status(200).json({ message: `Supplier ${decision.toLowerCase()}`, supplier });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── 8. ADMIN: SUSPEND / ACTIVATE / BLOCK SUPPLIER ──────────────────────────
// @route   PATCH /api/admin/suppliers/:id/status
// @access  Private (super_admin)
exports.adminUpdateSupplierStatus = async (req, res) => {
  try {
    const { status } = req.body;

    if (!["ACTIVE", "SUSPENDED", "BLOCKED", "UNDER_REVIEW"].includes(status)) {
      return res.status(400).json({ message: "Invalid status value" });
    }

    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) {
      return res.status(404).json({ message: "Supplier not found" });
    }

    supplier.status = status;
    await supplier.save();

    return res.status(200).json({ message: `Supplier status set to ${status}`, supplier });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};