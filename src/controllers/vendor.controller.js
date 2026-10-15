const Vendor = require("../models/Vendor");
const Product = require("../models/Product");
const Category = require("../models/Category");
const Store = require("../models/Store");
const User = require("../models/User");

// Enable seller mode for the authenticated super admin while preserving the
// super_admin role, then create the vendor profile and store used by seller APIs.
exports.becomeSeller = async (req, res) => {
  try {
    if (req.user.role !== "super_admin") {
      return res.status(403).json({ message: "Only super admins can activate seller mode" });
    }

    const businessName = String(req.body.businessName || req.body.storeName || "").trim();
    const phone = String(req.body.phone || req.body.businessPhone || "").trim();
    const email = String(req.body.email || req.body.businessEmail || "").trim().toLowerCase();
    const description = String(req.body.description || req.body.shortDescription || "").trim();
    if (!businessName || !phone || !email) {
      return res.status(400).json({ message: "Business/store name, business phone, and business email are required" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: "A valid business email is required" });
    }

    const existingVendor = await Vendor.findOne({ user: req.user._id });
    if (existingVendor) {
      if (!req.user.isSellerEnabled) {
        await User.updateOne(
          { _id: req.user._id },
          { $set: { isSellerEnabled: true } },
        );
      }
      return res.status(200).json({ message: "Seller mode is already enabled", isSellerEnabled: true, vendor: existingVendor });
    }

    const slugBase = businessName.toLowerCase().trim()
      .replace(/\s+/g, "-").replace(/[^\w-]+/g, "").replace(/--+/g, "-")
      .replace(/^-|-$/g, "") || "store";
    let storeSlug = slugBase;
    if (await Store.exists({ slug: storeSlug })) storeSlug = `${slugBase}-${Date.now().toString(36)}`;

    const vendor = await Vendor.create({
      user: req.user._id,
      businessName,
      description,
      phone,
      email,
      verificationStatus: "VERIFIED",
      status: "ACTIVE",
    });
    let store;
    try {
      store = await Store.create({
        vendor: req.user._id,
        isPrimary: !(await Store.exists({ vendor: req.user._id })),
        storeName: businessName,
        slug: storeSlug,
        description,
        contactEmail: email,
        contactPhone: phone,
        businessPhone: phone,
        location: "Kigali",
        address: { city: "Kigali", country: "Rwanda" },
        businessAddress: "Kigali, Rwanda",
        status: "ACTIVE",
      });

      // `protect` intentionally excludes password from its user query. Use an
      // atomic update instead of saving that partial document, which would
      // otherwise fail User's required-password validation.
      await User.updateOne(
        { _id: req.user._id },
        { $set: { isSellerEnabled: true, companyName: businessName } },
      );
    } catch (error) {
      await Promise.all([
        Store.deleteOne({ _id: store?._id }),
        Vendor.deleteOne({ _id: vendor._id }),
      ]);
      throw error;
    }

    return res.status(201).json({
      message: "Seller mode activated",
      isSellerEnabled: true,
      vendor,
      store,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "A store or vendor profile with this information already exists" });
    }
    return res.status(400).json({ message: error.message });
  }
};

// ─── 1. ONBOARD VENDOR ──────────────────────────────────────────────────────
// @route   POST /api/vendors/onboard
// @access  Private (role: "vendor")
exports.onboardVendor = async (req, res) => {
  try {
    if (req.user.role !== "vendor") {
      return res.status(403).json({ message: "Only vendor accounts can create a vendor profile" });
    }

    const existing = await Vendor.findOne({ user: req.user.id });
    const created = !existing;
    const { businessName, description, phone, email, logoUrl, category, bannerUrl, location, address } = req.body;

    if (!businessName || !phone || !email || !description || !logoUrl || !category || !(location || address)) {
      return res.status(400).json({ message: "Business name, phone, email, description, logo, category, and location are required." });
    }

    let locationVal = location !== undefined ? location : null;
    if (!locationVal && address) {
      locationVal = typeof address === "object" ? (address.city || address.street) : address;
    }

    const vendor = existing || new Vendor({ user: req.user.id });
    Object.assign(vendor, { businessName, description, phone, email, logoUrl, category, bannerUrl, location: locationVal, verificationStatus: "PENDING", verificationNote: "" });
    await vendor.save();
    require("../services/notification.service").profileSubmitted({ kind: "seller", name: businessName, resubmitted: !created }).catch(() => {});
    await User.findByIdAndUpdate(req.user.id, { companyName: businessName, businessName, description, logoUrl, category, location: locationVal, isOnboarded: true, verificationStatus: "PENDING" });

    // Auto-sync Store record so all store/staff/settings endpoints function seamlessly
    try {
      const Store = require("../models/Store");
      const { getPrimaryStore } = require("../utils/vendorStore.util");
      let store = await getPrimaryStore(req.user.id);
      if (!store) {
        const createSlug = (text) =>
          text
            .toString()
            .toLowerCase()
            .trim()
            .replace(/\s+/g, "-")
            .replace(/[^\w\-]+/g, "")
            .replace(/\-\-+/g, "-");
        let slugCandidate = createSlug(businessName);
        const slugExists = await Store.findOne({ slug: slugCandidate });
        if (slugExists) {
          slugCandidate = `${slugCandidate}-${Date.now().toString(36)}`;
        }

        const cityStr = typeof locationVal === "string" ? locationVal : (typeof address === "object" && address?.city ? address.city : "Kigali");
        const streetStr = typeof address === "object" && address?.street ? address.street : (typeof locationVal === "string" ? locationVal : "");

        await Store.create({
          vendor: req.user.id,
          isPrimary: true,
          storeName: businessName,
          slug: slugCandidate,
          description: description || "",
          contactEmail: email,
          contactPhone: phone,
          logo: logoUrl || "",
          banner: bannerUrl || "",
          location: locationVal || cityStr,
          address: {
            street: streetStr,
            city: cityStr,
            country: (typeof address === "object" && address?.country) || "Rwanda",
          },
          businessAddress: streetStr || cityStr,
          status: "ACTIVE",
        });
      }
    } catch (storeErr) {
      // Non-fatal
      console.error("Auto-sync Store error on vendor onboarding:", storeErr.message);
    }

    return res.status(created ? 201 : 200).json({ message: created ? "Vendor profile created" : "Vendor profile updated", vendor });
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

    const { businessName, description, phone, email, logoUrl, bannerUrl, location, address, category } = req.body;

    // Editable fields — excludes verificationStatus, ratingAvg, status, commissionRate
    if (businessName !== undefined) vendor.businessName = businessName;
    if (category !== undefined) vendor.category = String(category || "").slice(0, 120);
    if (description !== undefined) vendor.description = description;
    if (phone !== undefined) vendor.phone = phone;
    if (email !== undefined) vendor.email = email;
    if (logoUrl !== undefined) vendor.logoUrl = logoUrl;
    if (bannerUrl !== undefined) vendor.bannerUrl = bannerUrl;
    if (location !== undefined) {
      vendor.location = location;
    } else if (address !== undefined) {
      vendor.location = typeof address === "object" ? (address.city || address.street) : address;
    }

    // A rejected profile that has been fixed goes straight back to MVEC for review.
    const resubmitted = vendor.verificationStatus === "REJECTED";
    if (resubmitted) {
      vendor.verificationStatus = "PENDING";
      vendor.verificationNote = "";
    }
    await vendor.save();
    if (resubmitted) {
      await User.findByIdAndUpdate(req.user.id, { verificationStatus: "PENDING" });
      require("../services/notification.service").profileSubmitted({ kind: "seller", name: vendor.businessName, resubmitted: true }).catch(() => {});
    }

    // Sync Store record
    try {
      const { getPrimaryStore } = require("../utils/vendorStore.util");
      const store = await getPrimaryStore(req.user.id);
      if (store) {
        if (businessName !== undefined) store.storeName = businessName;
        if (description !== undefined) store.description = description;
        if (phone !== undefined) store.contactPhone = phone;
        if (email !== undefined) store.contactEmail = email;
        if (logoUrl !== undefined) store.logo = logoUrl;
        if (bannerUrl !== undefined) store.banner = bannerUrl;
        if (location !== undefined || address !== undefined) {
          const loc = location !== undefined ? location : address;
          store.location = loc;
          const cityStr = typeof loc === "string" ? loc : (loc?.city || store.address?.city || "Kigali");
          const streetStr = typeof address === "object" && address?.street ? address.street : (store.address?.street || "");
          store.address = {
            street: streetStr,
            city: cityStr,
            country: store.address?.country || "Rwanda",
          };
        }
        await store.save();
      }
    } catch (storeErr) {
      console.error("Auto-sync Store error on vendor profile update:", storeErr.message);
    }

    return res.status(200).json({ message: resubmitted ? "Profile saved and sent to MVEC for review again." : "Vendor profile updated", vendor });
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
// Shape returned by the public storefront endpoints. Internal fields such as
// the commission rate stay private; `id`/`userId` are what clients link with.
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const toPublicVendor = (v) => ({
  id: v._id.toString(),
  _id: v._id.toString(),
  userId: v.user ? v.user.toString() : null,
  publicId: v.publicId,
  businessName: v.businessName,
  slug: v.slug,
  logoUrl: v.logoUrl,
  bannerUrl: v.bannerUrl,
  description: v.description,
  category: v.category,
  location: v.location,
  phone: v.phone,
  email: v.email,
  ratingAvg: v.ratingAvg,
  verificationStatus: v.verificationStatus,
  status: v.status,
});

// Active sellers that are verified or already selling something, verified
// sellers first. The shop shows products of every active seller, so the
// vendor directory lists the same sellers (with a Verified badge when earned).
exports.getVendors = async (req, res) => {
  try {
    const { q, location, page = 1, pageSize = 20, verified } = req.query;
    const Product = require("../models/Product");

    const selling = await Product.distinct("vendor", { status: "ACTIVE" });
    const filter = {
      status: "ACTIVE",
      $or: [{ verificationStatus: "VERIFIED" }, { user: { $in: selling } }],
    };
    if (verified === "true") {
      delete filter.$or;
      filter.verificationStatus = "VERIFIED";
    }
    if (q) {
      filter.businessName = { $regex: escapeRegex(String(q).slice(0, 100)), $options: "i" };
    }
    if (location && typeof location === "string") {
      filter.location = location;
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limit = Math.min(parseInt(pageSize, 10) || 20, 100);

    const all = await Vendor.find(filter);
    all.sort((a, b) => (b.verificationStatus === "VERIFIED") - (a.verificationStatus === "VERIFIED") || (Number(b.ratingAvg) || 0) - (Number(a.ratingAvg) || 0));
    const vendors = all.slice((pageNum - 1) * limit, pageNum * limit);

    return res.status(200).json({
      data: vendors.map(toPublicVendor),
      meta: { page: pageNum, pageSize: limit, total: all.length },
    });
  } catch (error) {
    console.error("Vendor list failed:", error);
    return res.status(500).json({ message: "We could not load the stores right now. Please try again." });
  }
};

// ─── 5. PUBLIC VENDOR STOREFRONT ────────────────────────────────────────────
// @route   GET /api/vendors/:idOrSlug
// @access  Public
exports.getVendorByIdOrSlug = async (req, res) => {
  try {
    const idOrSlug = String(req.params.idOrSlug);
    const isObjectId = idOrSlug.match(/^[0-9a-fA-F]{24}$/);

    const query = isObjectId ? { _id: idOrSlug } : { slug: idOrSlug };

    // Same rule as the directory: active and verified, or already selling.
    const vendor = await Vendor.findOne({ ...query, status: "ACTIVE" });
    const Product = require("../models/Product");
    const visible = vendor && (vendor.verificationStatus === "VERIFIED" || (await Product.exists({ vendor: vendor.user, status: "ACTIVE" })));

    if (!visible) {
      return res.status(404).json({ message: "Vendor store not found" });
    }

    return res.status(200).json({ vendor: toPublicVendor(vendor) });
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

    // Enrich with per-vendor product counts + category breakdown for admin tables
    // Product.vendor stores the owner User ID, not the Vendor profile ID.
    // Aggregate against populated owner IDs so admin product counts match the catalog.
    const vendorIds = vendors.map((v) => v.user?._id || v.user).filter(Boolean);
    let productStats = [];
    if (vendorIds.length) {
      productStats = await Product.aggregate([
        { $match: { vendor: { $in: vendorIds }, status: { $ne: "INACTIVE" } } },
        { $group: { _id: "$vendor", productCount: { $sum: 1 }, categories: { $addToSet: "$category" } } },
      ]);
    }
    const categoryIds = [...new Set(productStats.flatMap((s) => s.categories || []))];
    const categoryNames = await Category.find({ _id: { $in: categoryIds } }).select("name");
    const catName = {};
    categoryNames.forEach((c) => { catName[String(c._id)] = c.name; });

    const statsByVendor = new Map(productStats.map((s) => [String(s._id), s]));
    const enriched = vendors.map((v) => {
      const ownerId = v.user?._id || v.user;
      const stats = statsByVendor.get(String(ownerId)) || { productCount: 0, categories: [] };
      const categories = (stats.categories || [])
        .map((cid) => catName[String(cid)] || null)
        .filter(Boolean);
      return {
        ...v.toObject(),
        productCount: Number(stats.productCount) || 0,
        productCategories: categories,
        category: v.category || categories[0] || "",
      };
    });

    return res.status(200).json({
      data: enriched,
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
    const reason = String(req.body.reason || "").trim().slice(0, 500);

    if (!["VERIFIED", "REJECTED"].includes(decision)) {
      return res.status(400).json({ message: "Choose to verify or reject the seller." });
    }
    if (decision === "REJECTED" && reason.length < 5) {
      return res.status(400).json({ message: "Tell the seller what to fix: write a short reason for the rejection." });
    }

    const vendor = await Vendor.findById(req.params.id);
    if (!vendor) {
      return res.status(404).json({ message: "Vendor not found" });
    }

    vendor.verificationStatus = decision;
    vendor.verificationNote = decision === "REJECTED" ? reason : "";
    await vendor.save();
    await User.findByIdAndUpdate(vendor.user, { verificationStatus: decision });
    await require("../services/notification.service").verificationDecision(vendor.user, { kind: "seller", name: vendor.businessName, decision, reason });

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

// ─── SELLER'S AFFILIATE PROGRAM ─────────────────────────────────────────────
// @route   GET /api/vendors/me/affiliate-program
// @access  Private (vendor, staff with canManageProducts)
exports.getAffiliateProgram = async (req, res) => {
  const program = require("../services/affiliateProgram.service");
  try {
    const ownerId = req.vendorId || req.user.id;
    const [settings, stats] = await Promise.all([program.getVendorProgram(ownerId), program.vendorProgramStats(ownerId)]);
    return res.status(200).json({ program: settings, stats, maxRatePercent: program.MAX_VENDOR_RATE });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    console.error("Affiliate program load failed:", error);
    return res.status(500).json({ message: "We could not load your affiliate program right now. Please try again." });
  }
};

// @route   PUT /api/vendors/me/affiliate-program   { enabled, ratePercent, scope: ALL|SELECTED, productIds? }
// @access  Private (vendor, staff with canManageSettings)
exports.updateAffiliateProgram = async (req, res) => {
  const program = require("../services/affiliateProgram.service");
  try {
    const ownerId = req.vendorId || req.user.id;
    const { enabled, ratePercent, scope, productIds } = req.body || {};
    const settings = await program.updateVendorProgram(ownerId, { enabled, ratePercent, scope, productIds });
    const message = settings.enabled
      ? `Affiliate program is on: affiliates earn ${settings.totalPercent}% on ${settings.scope === "ALL" ? "all your products" : "the products you chose"} (${settings.ratePercent}% paid by you).`
      : "Affiliate program is off. Affiliates can no longer promote your products; orders already placed keep their commission.";
    return res.status(200).json({ message, program: settings });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ message: error.message });
    console.error("Affiliate program update failed:", error);
    return res.status(500).json({ message: "We could not save your affiliate program right now. Please try again." });
  }
};
