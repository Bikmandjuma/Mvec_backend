const Vendor = require("../models/Vendor");

// ─── 1. ONBOARD VENDOR ──────────────────────────────────────────────────────
// @route   POST /api/vendors/onboard
// @access  Private (role: "vendor")
exports.onboardVendor = async (req, res) => {
  try {
    if (req.user.role !== "vendor") {
      return res.status(403).json({ message: "Only vendor accounts can create a vendor profile" });
    }

    const existing = await Vendor.findOne({ user: req.user.id });
    if (existing) {
      return res.status(409).json({ message: "Vendor profile already exists" });
    }

    const { businessName, description, phone, email, logoUrl, bannerUrl, location } = req.body;

    if (!businessName || !phone || !email) {
      return res.status(400).json({ message: "businessName, phone, and email are required" });
    }

    const vendor = await Vendor.create({
      user: req.user.id,
      businessName,
      description,
      phone,
      email,
      logoUrl,
      bannerUrl,
      location: location || null,
    });

    return res.status(201).json({ message: "Vendor profile created", vendor });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "A vendor with this business name already exists" });
    }
    return res.status(400).json({ message: error.message });
  }
};

// ─── 2. GET OWN VENDOR PROFILE ──────────────────────────────────────────────
// @route   GET /api/vendors/me/profile
// @access  Private (role: "vendor")
exports.getMyProfile = async (req, res) => {
  try {
    const vendor = await Vendor.findOne({ user: req.user.id });
    if (!vendor) {
      return res.status(404).json({ message: "Vendor profile not found. Please complete onboarding." });
    }
    return res.status(200).json({ vendor });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── 3. UPDATE OWN VENDOR PROFILE ───────────────────────────────────────────
// @route   PATCH /api/vendors/me/profile
// @access  Private (role: "vendor")
exports.updateMyProfile = async (req, res) => {
  try {
    const vendor = await Vendor.findOne({ user: req.user.id });
    if (!vendor) {
      return res.status(404).json({ message: "Vendor profile not found. Please complete onboarding." });
    }

    const { businessName, description, phone, email, logoUrl, bannerUrl, location } = req.body;

    // Editable fields — excludes verificationStatus, ratingAvg, status, commissionRate
    if (businessName !== undefined) vendor.businessName = businessName;
    if (description !== undefined) vendor.description = description;
    if (phone !== undefined) vendor.phone = phone;
    if (email !== undefined) vendor.email = email;
    if (logoUrl !== undefined) vendor.logoUrl = logoUrl;
    if (bannerUrl !== undefined) vendor.bannerUrl = bannerUrl;
    if (location !== undefined) vendor.location = location;

    await vendor.save();
    return res.status(200).json({ message: "Vendor profile updated", vendor });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "A vendor with this business name already exists" });
    }
    return res.status(400).json({ message: error.message });
  }
};

// ─── 4. PUBLIC VENDOR DIRECTORY ─────────────────────────────────────────────
// @route   GET /api/vendors?q=&location=&page=&pageSize=
// @access  Public
exports.getVendors = async (req, res) => {
  try {
    const { q, location, page = 1, pageSize = 20 } = req.query;

    const filter = {
      status: "ACTIVE",
      verificationStatus: "VERIFIED",
    };

    if (q) {
      filter.businessName = { $regex: q, $options: "i" };
    }
    if (location) {
      filter.location = location;
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limit = Math.min(parseInt(pageSize, 10) || 20, 100);
    const skip = (pageNum - 1) * limit;

    const [vendors, total] = await Promise.all([
      Vendor.find(filter).sort({ ratingAvg: -1 }).skip(skip).limit(limit),
      Vendor.countDocuments(filter),
    ]);

    return res.status(200).json({
      data: vendors,
      meta: { page: pageNum, pageSize: limit, total },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── 5. PUBLIC VENDOR STOREFRONT ────────────────────────────────────────────
// @route   GET /api/vendors/:idOrSlug
// @access  Public
exports.getVendorByIdOrSlug = async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const isObjectId = idOrSlug.match(/^[0-9a-fA-F]{24}$/);

    const query = isObjectId ? { _id: idOrSlug } : { slug: idOrSlug };

    const vendor = await Vendor.findOne({
      ...query,
      status: "ACTIVE",
      verificationStatus: "VERIFIED",
    });

    if (!vendor) {
      return res.status(404).json({ message: "Vendor store not found" });
    }

    return res.status(200).json({ vendor });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── 6. ADMIN: LIST ALL VENDORS ─────────────────────────────────────────────
// @route   GET /api/admin/vendors?status=&verificationStatus=&page=&pageSize=
// @access  Private (super_admin)
exports.adminGetVendors = async (req, res) => {
  try {
    const { status, verificationStatus, page = 1, pageSize = 20 } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (verificationStatus) filter.verificationStatus = verificationStatus;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limit = Math.min(parseInt(pageSize, 10) || 20, 100);
    const skip = (pageNum - 1) * limit;

    const [vendors, total] = await Promise.all([
      Vendor.find(filter).populate("user", "Fullname email phone").skip(skip).limit(limit),
      Vendor.countDocuments(filter),
    ]);

    return res.status(200).json({
      data: vendors,
      meta: { page: pageNum, pageSize: limit, total },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── 7. ADMIN: VERIFY / REJECT VENDOR ───────────────────────────────────────
// @route   PATCH /api/admin/vendors/:id/verify
// @access  Private (super_admin)
exports.adminVerifyVendor = async (req, res) => {
  try {
    const { decision } = req.body; // "VERIFIED" | "REJECTED"

    if (!["VERIFIED", "REJECTED"].includes(decision)) {
      return res.status(400).json({ message: "decision must be VERIFIED or REJECTED" });
    }

    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) {
      return res.status(404).json({ message: "Vendor not found" });
    }

    vendor.verificationStatus = decision;
    await vendor.save();

    return res.status(200).json({ message: `Vendor ${decision.toLowerCase()}`, vendor });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// ─── 8. ADMIN: SUSPEND / ACTIVATE / BLOCK VENDOR ────────────────────────────
// @route   PATCH /api/admin/vendors/:id/status
// @access  Private (super_admin)
exports.adminUpdateVendorStatus = async (req, res) => {
  try {
    const { status } = req.body;

    if (!["ACTIVE", "SUSPENDED", "BLOCKED", "UNDER_REVIEW"].includes(status)) {
      return res.status(400).json({ message: "Invalid status value" });
    }

    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) {
      return res.status(404).json({ message: "Vendor not found" });
    }

    vendor.status = status;
    await vendor.save();

    return res.status(200).json({ message: `Vendor status set to ${status}`, vendor });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};