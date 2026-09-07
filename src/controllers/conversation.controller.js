const Conversation = require("../models/Conversation");
const Message = require("../models/Message");
const User = require("../models/User");

// @desc    Initialize or retrieve conversation thread
// @route   POST /api/conversations
// @access  Private
exports.createConversation = async (req, res) => {
  try {
    const { recipientId, subject } = req.body;
    const senderId = req.user.id;

    if (!recipientId) {
      return res.status(400).json({ message: "Recipient ID is required" });
    }

    if (recipientId.toString() === senderId.toString()) {
      return res.status(400).json({ message: "Cannot create a conversation with yourself" });
    }

    const recipientExists = await User.findById(recipientId);
    if (!recipientExists) {
      return res.status(404).json({ message: "Recipient user not found" });
    }

    // Check if thread already exists between these 2 users
    let conversation = await Conversation.findOne({
      participants: { $all: [senderId, recipientId], $size: 2 },
    }).populate("participants", "Fullname email companyName logoUrl role");

    if (!conversation) {
      conversation = await Conversation.create({
        participants: [senderId, recipientId],
        subject: subject || "",
      });

      conversation = await conversation.populate(
        "participants",
        "Fullname email companyName logoUrl role"
      );
    }

    return res.status(200).json({ conversation });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Get user's active conversations
// @route   GET /api/conversations
// @access  Private
exports.getConversations = async (req, res) => {
  try {
    const conversations = await Conversation.find({
      participants: req.user.id,
    })
      .sort({ lastMessageAt: -1 })
      .populate("participants", "Fullname email companyName logoUrl role");

    return res.status(200).json({ conversations });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Retrieve message history for thread
// @route   GET /api/conversations/:id/messages
// @access  Private
exports.getMessages = async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 30 } = req.query;

    const conversation = await Conversation.findById(id);
    if (!conversation) {
      return res.status(404).json({ message: "Conversation thread not found" });
    }

    // Verify user is a participant
    const isParticipant = conversation.participants.some(
      (p) => p.toString() === req.user.id.toString()
    );
    if (!isParticipant) {
      return res.status(403).json({ message: "Access denied to this conversation" });
    }

    const pageNum = Math.max(parseInt(page, 10) || 1, 1);
    const limitNum = Math.min(parseInt(limit, 10) || 30, 100);
    const skip = (pageNum - 1) * limitNum;

    const [messages, total] = await Promise.all([
      Message.find({ conversation: id })
        .sort({ createdAt: -1 }) // Latest first for pagination
        .skip(skip)
        .limit(limitNum)
        .populate("sender", "Fullname email role"),
      Message.countDocuments({ conversation: id }),
    ]);

    return res.status(200).json({
      meta: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
      },
      messages: messages.reverse(), // Reverse so UI renders chronologically
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Send new message in active thread
// @route   POST /api/conversations/:id/messages
// @access  Private
exports.sendMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const { content, attachments } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ message: "Message content is required" });
    }

    const conversation = await Conversation.findById(id);
    if (!conversation) {
      return res.status(404).json({ message: "Conversation thread not found" });
    }

    const isParticipant = conversation.participants.some(
      (p) => p.toString() === req.user.id.toString()
    );
    if (!isParticipant) {
      return res.status(403).json({ message: "Access denied to this conversation" });
    }

    const message = await Message.create({
      conversation: id,
      sender: req.user.id,
      content,
      attachments: attachments || [],
      readBy: [req.user.id],
    });

    // Cache last message info on thread
    conversation.lastMessage = content;
    conversation.lastMessageAt = Date.now();
    await conversation.save();

    await message.populate("sender", "Fullname email role");

    return res.status(201).json({ message });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};