const mongoose = require("mongoose");

const caseCommentSchema = new mongoose.Schema(
  {
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
    },
    attachments: [{ type: String }],
  },
  { timestamps: true }
);

const supportCaseSchema = new mongoose.Schema(
  {
    ticketNumber: {
      type: String,
      unique: true,
      required: true,
    },
    openedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    subject: {
      type: String,
      required: [true, "Subject is required"],
      trim: true,
    },
    category: {
      type: String,
      enum: ["ORDER", "PAYMENT", "ACCOUNT", "VENDOR_ONBOARDING", "TECHNICAL", "OTHER"],
      default: "OTHER",
    },
    priority: {
      type: String,
      enum: ["LOW", "MEDIUM", "HIGH", "URGENT"],
      default: "MEDIUM",
    },
    status: {
      type: String,
      enum: ["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"],
      default: "OPEN",
    },
    description: {
      type: String,
      required: [true, "Description is required"],
    },
    comments: [caseCommentSchema],
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SupportCase", supportCaseSchema);