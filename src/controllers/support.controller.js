const SupportCase = require("../models/SupportCase");

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

    if (!subject || !description) {
      return res.status(400).json({ message: "Subject and description are required" });
    }

    const supportCase = await SupportCase.create({
      ticketNumber: generateTicketNumber(),
      openedBy: req.user.id,
      subject,
      category: category || "OTHER",
      priority: priority || "MEDIUM",
      description,
    });

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

    // Re-open case if customer replies to a resolved case
    if (isOwner && supportCase.status === "RESOLVED") {
      supportCase.status = "IN_PROGRESS";
    }

    await supportCase.save();
    await supportCase.populate("comments.author", "Fullname email role");

    return res.status(200).json({
      message: "Comment added",
      comments: supportCase.comments,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};