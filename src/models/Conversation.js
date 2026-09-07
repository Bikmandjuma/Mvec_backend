const mongoose = require("mongoose");

const conversationSchema = new mongoose.Schema(
  {
    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },
    ],
    subject: {
      type: String,
      trim: true,
      default: "",
    },
    lastMessage: {
      type: String,
      default: "",
    },
    lastMessageAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// Index to quickly find user conversations
conversationSchema.index({ participants: 1 });

module.exports = mongoose.model("Conversation", conversationSchema);