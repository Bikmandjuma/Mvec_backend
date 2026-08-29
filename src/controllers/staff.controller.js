const Staff = require("../models/Staff");
const User = require("../models/User");
const Store = require("../models/Store");

// @desc    Add / Invite a staff member to store
// @route   POST /api/staff
// @access  Private (Vendor Owner Only)
exports.addStaffMember = async (req, res) => {
  try {
    const { email, role, permissions } = req.body;

    const store = await Store.findOne({ owner: req.user.id });
    if (!store) {
      return res.status(404).json({ message: "You must create a store before adding staff." });
    }

    const userToInvite = await User.findOne({ email });
    if (!userToInvite) {
      return res.status(404).json({ message: "User with this email does not exist." });
    }

    const existingStaff = await Staff.findOne({ store: store._id, user: userToInvite._id });
    if (existingStaff) {
      return res.status(400).json({ message: "User is already a staff member of this store." });
    }

    // Default permission profiles by role if not explicitly passed
    let defaultPermissions = permissions || {};
    if (role === "CATALOG_MANAGER") {
      defaultPermissions = { canManageProducts: true, canManageOrders: false, canViewAnalytics: false, canManageSettings: false, ...permissions };
    } else if (role === "ORDER_MANAGER") {
      defaultPermissions = { canManageProducts: false, canManageOrders: true, canViewAnalytics: false, canManageSettings: false, ...permissions };
    } else if (role === "STORE_MANAGER") {
      defaultPermissions = { canManageProducts: true, canManageOrders: true, canViewAnalytics: true, canManageSettings: false, ...permissions };
    }

    const staff = await Staff.create({
      store: store._id,
      vendorOwner: req.user.id,
      user: userToInvite._id,
      role: role || "ORDER_MANAGER",
      permissions: defaultPermissions,
      status: "ACTIVE",
    });

    return res.status(201).json({ message: "Staff member added successfully", staff });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Get all staff members for logged-in vendor's store
// @route   GET /api/staff
// @access  Private (Vendor Owner Only)
exports.getStoreStaff = async (req, res) => {
  try {
    const store = await Store.findOne({ owner: req.user.id });
    if (!store) return res.status(404).json({ message: "Store not found." });

    const staffList = await Staff.find({ store: store._id }).populate("user", "Fullname email role");
    return res.status(200).json({ staff: staffList });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Update staff role or permissions
// @route   PUT /api/staff/:id
// @access  Private (Vendor Owner Only)
exports.updateStaffMember = async (req, res) => {
  try {
    const { role, permissions, status } = req.body;

    const staff = await Staff.findById(req.params.id);
    if (!staff) return res.status(404).json({ message: "Staff record not found." });

    if (staff.vendorOwner.toString() !== req.user.id.toString()) {
      return res.status(403).json({ message: "Unauthorized to modify this staff member." });
    }

    if (role) staff.role = role;
    if (status) staff.status = status;
    if (permissions) staff.permissions = { ...staff.permissions, ...permissions };

    await staff.save();
    return res.status(200).json({ message: "Staff permissions updated", staff });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

// @desc    Remove staff member
// @route   DELETE /api/staff/:id
// @access  Private (Vendor Owner Only)
exports.removeStaffMember = async (req, res) => {
  try {
    const staff = await Staff.findById(req.params.id);
    if (!staff) return res.status(404).json({ message: "Staff record not found." });

    if (staff.vendorOwner.toString() !== req.user.id.toString()) {
      return res.status(403).json({ message: "Unauthorized to remove this staff member." });
    }

    await staff.deleteOne();
    return res.status(200).json({ message: "Staff member removed successfully." });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};