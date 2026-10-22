const SupportCase = require("../models/SupportCase");
const notifications = require("../services/notification.service");

// Where the person who opened a request reads it, by their role.
const supportPageFor = async (userId) => {
  const user = await require("../models/User").findById(userId).select("role").lean();
  return { vendor: "/vendor/support", supplier: "/supplier/support", affiliate: "/affiliate/support", delivery: "/delivery/support" }[user?.role] || "/support";
};

// Utility helper to generate unique ticket numbers
const generateTicketNumber = () => {
  return `TKT-${Date.now().toString().slice(-6)}-${Math.floor(1000 + Math.random() * 9000)}`;
};

// @desc    Open a new support ticket
// @route   POST /api/support/cases
// @access  Private
exports.createSupportCase = async (req, res) => {
  try {
    const { subject, category, priority, description } = req.body;

    if (req.user.role === "super_admin") {
      return res.status(400).json({ message: "Admins answer support requests; they don't open them." });
    }
    if (!subject || !description) {
      return res.status(400).json({ message: "Subject and description are required" });
    }
    const CATEGORIES = ["ORDER", "PAYMENT", "ACCOUNT", "VENDOR_ONBOARDING", "TECHNICAL", "OTHER"];
    const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"];

    // Premium sellers/suppliers get priority support (only while plans are on).
    let chosenPriority = PRIORITIES.includes(priority) ? priority : "MEDIUM";
    if (["vendor", "supplier"].includes(req.user.role)) {
      const ent = await require("../services/plans.service").entitlements(req.user.id);
      if (ent.plan === "PREMIUM" && ["LOW", "MEDIUM"].includes(chosenPriority)) chosenPriority = "HIGH";
    }
    const supportCase = await SupportCase.create({
      ticketNumber: generateTicketNumber(),
      openedBy: req.user.id,
      subject: String(subject).slice(0, 200),
      category: CATEGORIES.includes(category) ? category : "OTHER",
      priority: chosenPriority,
      description,
    });
    notifications.adminAlert({
      title: `${supportCase.priority === "URGENT" ? "URGENT support request" : "New support request"}: ${supportCase.subject}`,
      message: `${req.user.Fullname || "A user"} (${req.user.role}) · ${supportCase.ticketNumber}`,
      link: `/admin/support?case=${supportCase._id}`,
    }).catch(() => {});

    return res.status(201).json({
      message: "Support ticket created successfully",
      case: supportCase,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Fetch details and updates on an active case
// @route   GET /api/support/cases/:id
// @access  Private
exports.getSupportCaseById = async (req, res) => {
  try {
    const { id } = req.params;

    const supportCase = await SupportCase.findById(id)
      .populate("openedBy", "Fullname email role")
      .populate("assignedTo", "Fullname email")
      .populate("comments.author", "Fullname email role");

    if (!supportCase) {
      return res.status(404).json({ message: "Support case not found" });
    }

    // Access Check: Owner or Admin/Support Staff
    const isOwner = supportCase.openedBy._id.toString() === req.user.id.toString();
    const isAdmin = ["admin", "super_admin", "support"].includes(req.user.role);

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: "Access denied to this support case" });
    }

    return res.status(200).json({ case: supportCase });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    List support cases (all for staff, own for regular users)
// @route   GET /api/support/cases
// @access  Private
exports.listSupportCases = async (req, res) => {
  try {
    const isStaff = ["admin", "super_admin", "support"].includes(req.user.role);
    const filter = isStaff ? {} : { openedBy: req.user.id };
    const { status, page = 1, pageSize = 50 } = req.query;
    if (status) filter.status = status;

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limit = Math.min(parseInt(pageSize, 10) || 50, 100);
    const skip = (pageNum - 1) * limit;

    const [cases, total] = await Promise.all([
      SupportCase.find(filter)
        .populate("openedBy", "Fullname email role")
        .populate("assignedTo", "Fullname email")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      SupportCase.countDocuments(filter),
    ]);

    return res.status(200).json({ cases, meta: { page: pageNum, pageSize: limit, total } });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Update support case status / assignee (staff only)
// @route   PATCH /api/support/cases/:id/status
// @access  Private (admin, super_admin, support)
exports.updateSupportCaseStatus = async (req, res) => {
  try {
    const isStaff = ["admin", "super_admin", "support"].includes(req.user.role);
    if (!isStaff) {
      return res.status(403).json({ message: "Only support staff can update case status." });
    }

    const { id } = req.params;
    const { status, assignedTo } = req.body;

    const allowed = ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"];
    if (!status || !allowed.includes(status)) {
      return res.status(400).json({ message: "Invalid status value" });
    }

    const supportCase = await SupportCase.findById(id);
    if (!supportCase) {
      return res.status(404).json({ message: "Support case not found" });
    }

    const changed = supportCase.status !== status;
    supportCase.status = status;
    if (assignedTo) supportCase.assignedTo = assignedTo;
    await supportCase.save();
    if (changed) {
      const words = { IN_PROGRESS: "is being handled", RESOLVED: "was resolved", CLOSED: "was closed", OPEN: "was reopened" };
      notifications.notify(supportCase.openedBy, {
        type: "ADMIN", title: `Your support request ${supportCase.ticketNumber} ${words[status] || "was updated"}`,
        message: supportCase.subject, link: await supportPageFor(supportCase.openedBy),
      }).catch(() => {});
    }

    return res.status(200).json({ message: "Support case updated", case: supportCase });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Add comment/update to a support case
// @route   POST /api/support/cases/:id/comments
// @access  Private
exports.addCaseComment = async (req, res) => {
  try {
    const { id } = req.params;
    const { message, attachments } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ message: "Comment message is required" });
    }

    const supportCase = await SupportCase.findById(id);
    if (!supportCase) {
      return res.status(404).json({ message: "Support case not found" });
    }

    const isOwner = supportCase.openedBy.toString() === req.user.id.toString();
    const isAdmin = ["admin", "super_admin", "support"].includes(req.user.role);

    if (!isOwner && !isAdmin) {
      return res.status(403).json({ message: "Access denied" });
    }

    supportCase.comments.push({
      author: req.user.id,
      message,
      attachments: attachments || [],
    });

    // Re-open case if customer replies to a resolved case; MVEC answering an open case means it is in progress.
    if (isOwner && supportCase.status === "RESOLVED") {
      supportCase.status = "IN_PROGRESS";
    }
    if (isAdmin && !isOwner && supportCase.status === "OPEN") {
      supportCase.status = "IN_PROGRESS";
      if (!supportCase.assignedTo) supportCase.assignedTo = req.user.id;
    }

    await supportCase.save();
    if (isAdmin && !isOwner) {
      notifications.notify(supportCase.openedBy, {
        type: "ADMIN", title: `MVEC replied to ${supportCase.ticketNumber}`, message: String(message).slice(0, 200), link: await supportPageFor(supportCase.openedBy),
        sms: `MVEC replied to your support request ${supportCase.ticketNumber}. Open MVEC to read it.`,
      }).catch(() => {});
    } else {
      const to = supportCase.assignedTo ? [supportCase.assignedTo] : null;
      const alert = { title: `Reply on ${supportCase.ticketNumber}: ${supportCase.subject}`, message: String(message).slice(0, 200), link: `/admin/support?case=${supportCase._id}` };
      (to ? notifications.notify(to[0], { type: "ADMIN", ...alert }) : notifications.adminAlert(alert)).catch(() => {});
    }
    await supportCase.populate("comments.author", "Fullname email role");

    return res.status(200).json({
      message: "Comment added",
      comments: supportCase.comments,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};