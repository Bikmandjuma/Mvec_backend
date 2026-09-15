const mongoose = require("mongoose");
const AbuseReport = require("../models/AbuseReport");
const User = require("../models/User");
const Order = require("../models/Order");
const Store = require("../models/Store");

const VALID_CATEGORIES = [
  "FRAUDULENT_ACTIVITY",
  "HARASSMENT_OR_ABUSE",
  "NON_COMPLIANT_PRODUCT_OR_ORDER",
  "OTHER_POLICY_VIOLATION",
];

const VALID_STATUSES = ["INVESTIGATE", "PENDING", "RESOLVED", "REJECTED"];

function mapReport(r) {
  const target =
    r.targetUser && typeof r.targetUser === "object" ? r.targetUser : null;
  const store =
    r.targetStore && typeof r.targetStore === "object" ? r.targetStore : null;
  const order =
    r.relatedOrder && typeof r.relatedOrder === "object" ? r.relatedOrder : null;
  const reporter =
    r.reporter && typeof r.reporter === "object" ? r.reporter : null;
  return {
    id: r._id,
    reportNumber: r.reportNumber,
    reporter: reporter ? reporter.Fullname : (r.reporter || null),
    targetUserId: r.targetUser && target ? target._id : r.targetUser,
    targetUser: target ? target.Fullname : null,
    targetRole: r.targetRole || target?.role || null,
    targetEmail: target?.email || null,
    store: store
      ? { id: store._id, name: store.storeName, slug: store.slug, logo: store.logo }
      : null,
    order: order
      ? { id: order._id, orderNumber: order.orderNumber, total: order.totalAmount }
      : null,
    reasonCategory: r.reasonCategory,
    description: r.description,
    evidenceUrls: r.evidenceUrls || [],
    incidentDate: r.incidentDate,
    status: r.status || "PENDING",
    adminNotes: r.adminNotes || "",
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

const populateOpts = [
  { path: "reporter", select: "Fullname email" },
  { path: "targetUser", select: "Fullname email role status companyName" },
  { path: "targetStore", select: "storeName slug logo businessCategory" },
  { path: "relatedOrder", select: "orderNumber totalAmount createdAt" },
];

// @desc    Submit a new abuse report
// @route   POST /api/abuse-reports
// @access  Private (vendor or admin)
exports.submitAbuseReport = async (req, res) => {
  try {
    const { targetUserId, reasonCategory, description, evidenceUrl, evidenceUrls, incidentDate, targetStoreId, targetRole, relatedOrderId } = req.body;

    if (!targetUserId || !mongoose.Types.ObjectId.isValid(String(targetUserId))) {
      return res.status(400).json({ message: "A valid target user is required" });
    }
    if (!reasonCategory || !VALID_CATEGORIES.includes(reasonCategory)) {
      return res.status(400).json({ message: "A valid reason category is required" });
    }
    if (!description || !String(description).trim()) {
      return res.status(400).json({ message: "Incident description is required" });
    }
    if (String(description).length > 2000) {
      return res.status(400).json({ message: "Description must be 2000 characters or fewer" });
    }

    const targetUser = await User.findById(targetUserId);
    if (!targetUser) {
      return res.status(404).json({ message: "Target user not found" });
    }

    let relatedOrder = null;
    if (relatedOrderId) {
      if (!mongoose.Types.ObjectId.isValid(String(relatedOrderId))) {
        return res.status(400).json({ message: "Invalid related order id" });
      }
      relatedOrder = await Order.findById(relatedOrderId);
      if (!relatedOrder) {
        return res.status(404).json({ message: "Related order not found" });
      }
    }

    let targetStore = null;
    if (targetStoreId) {
      if (!mongoose.Types.ObjectId.isValid(String(targetStoreId))) {
        return res.status(400).json({ message: "Invalid target store id" });
      }
      targetStore = await Store.findById(targetStoreId);
      if (!targetStore) {
        return res.status(404).json({ message: "Target store not found" });
      }
    }

    const count = await AbuseReport.countDocuments();
    const reportNumber = `ABR-${String(count + 1).padStart(4, "0")}`;

    const allEvidence = [];
    if (evidenceUrl) allEvidence.push(evidenceUrl);
    if (Array.isArray(evidenceUrls)) {
      for (const e of evidenceUrls) {
        if (typeof e === "string" && String(e).trim()) allEvidence.push(String(e).trim());
      }
    }

    const report = await AbuseReport.create({
      reportNumber,
      reporter: req.user._id,
      targetUser: targetUser._id,
      targetStore: targetStore?._id || null,
      targetRole: targetRole || targetUser.role,
      relatedOrder: relatedOrder?._id || null,
      reasonCategory,
      description: String(description).trim(),
      evidenceUrls: allEvidence.slice(0, 10),
      incidentDate: incidentDate ? new Date(incidentDate) : new Date(),
    });

    await AbuseReport.populate(report, populateOpts);
    return res.status(201).json({
      message: "Abuse report submitted. Our team will investigate shortly.",
      report: mapReport(report.toObject()),
    });
  } catch (error) {
    console.error("Error submitting abuse report:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// @desc    List abuse reports (vendor's own or admin all)
// @route   GET /api/abuse-reports
// @access  Private (vendor or admin)
exports.listAbuseReports = async (req, res) => {
  try {
    const { status, category } = req.query;
    const query = {};
    if (req.user.role === "vendor") {
      query.reporter = req.user._id;
    }
    if (status) query.status = status;
    if (category) query.reasonCategory = category;

    const reports = await AbuseReport.find(query)
      .populate(populateOpts)
      .sort({ createdAt: -1 });

    return res.status(200).json({
      data: reports.map((r) => mapReport(r.toObject())),
      meta: { total: reports.length },
    });
  } catch (error) {
    console.error("Error listing abuse reports:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// @desc    Get a single abuse report
// @route   GET /api/abuse-reports/:id
// @access  Private (vendor owner or admin)
exports.getAbuseReport = async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid report id" });
    }

    const report = await AbuseReport.findById(id).populate(populateOpts);
    if (!report) {
      return res.status(404).json({ message: "Abuse report not found" });
    }

    const reporter =
      report.reporter && typeof report.reporter === "object" ? report.reporter._id : report.reporter;
    const isOwner = String(reporter) === String(req.user._id);
    const isAdmin = req.user.role === "super_admin";
    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: "Not authorized to view this report" });
    }

    return res.status(200).json({ report: mapReport(report.toObject()) });
  } catch (error) {
    console.error("Error fetching abuse report:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// @desc    Update abuse report status / admin notes (admin only)
// @route   PATCH /api/abuse-reports/:id
// @access  Private (super_admin)
exports.updateAbuseReport = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, adminNotes } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid report id" });
    }
    if (status !== undefined && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const report = await AbuseReport.findById(id);
    if (!report) {
      return res.status(404).json({ message: "Abuse report not found" });
    }

    if (status !== undefined) {
      report.status = status;
      if (status === "RESOLVED" || status === "REJECTED") {
        report.resolvedAt = new Date();
      } else {
        report.resolvedAt = undefined;
      }
    }
    if (adminNotes !== undefined) report.adminNotes = String(adminNotes);

    await report.save();
    await AbuseReport.populate(report, populateOpts);
    return res.status(200).json({
      message: "Abuse report updated",
      report: mapReport(report.toObject()),
    });
  } catch (error) {
    console.error("Error updating abuse report:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};