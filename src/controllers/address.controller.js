// Saved delivery addresses on the signed-in account (/api/auth/addresses).
const User = require("../models/User");
const { normalizePhone } = require("../utils/sms.util");
const { readPin } = require("../config/delivery");

// @desc    Add a new address for logged-in user
// @route   POST /api/auth/addresses
// @access  Private
exports.addAddress = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id || req.user.userId;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const {
      type,
      country,
      provinceState,
      cityDistrict,
      sector,
      street,
      building,
      apartment,
      postalCode,
      phone,
      deliveryInstructions,
      isDefaultShipping,
      isDefaultBilling,
    } = req.body;

    if (user.addresses.length >= 10) {
      return res.status(400).json({ message: "You can save up to 10 addresses. Remove one first." });
    }
    const addressPhone = normalizePhone(phone);
    if (!addressPhone) {
      return res.status(400).json({ message: "Please enter a valid Rwandan phone number for this address." });
    }

    // Unset current default flags if this address is being set as default
    if (isDefaultShipping) {
      user.addresses.forEach((addr) => (addr.isDefaultShipping = false));
    }
    if (isDefaultBilling) {
      user.addresses.forEach((addr) => (addr.isDefaultBilling = false));
    }

    // First address added automatically becomes default
    const isFirstAddress = user.addresses.length === 0;

    user.addresses.push({
      type,
      country,
      provinceState,
      cityDistrict,
      sector,
      street,
      building,
      apartment,
      postalCode,
      phone: addressPhone,
      deliveryInstructions,
      ...(readPin(req.body, { label: "address pin" }) || {}),
      isDefaultShipping: isFirstAddress ? true : Boolean(isDefaultShipping),
      isDefaultBilling: isFirstAddress ? true : Boolean(isDefaultBilling),
    });

    await user.save();
    return res.status(201).json({
      message: "Address added successfully",
      addresses: user.addresses,
    });
  } catch (error) {
    console.error("Error adding address:", error);
    return res.status(400).json({ message: error.message });
  }
};

// @desc    Get all addresses for logged-in user
// @route   GET /api/auth/addresses
// @access  Private
exports.getAddresses = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id || req.user.userId;
    const user = await User.findById(userId).select("addresses");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({ addresses: user.addresses });
  } catch (error) {
    console.error("Error fetching addresses:", error);
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Internal server error" });
  }
};

// @desc    Update an existing address
// @route   PUT /api/auth/addresses/:addressId
// @access  Private
exports.updateAddress = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id || req.user.userId;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const address = user.addresses.id(req.params.addressId);
    if (!address) {
      return res.status(404).json({ message: "Address not found" });
    }

    const { isDefaultShipping, isDefaultBilling, _id, ...updateFields } = req.body;
    if (updateFields.phone !== undefined) {
      const addressPhone = normalizePhone(updateFields.phone);
      if (!addressPhone) {
        return res.status(400).json({ message: "Please enter a valid Rwandan phone number for this address." });
      }
      updateFields.phone = addressPhone;
    }

    // Handle default flag switches across other stored addresses
    if (isDefaultShipping) {
      user.addresses.forEach((addr) => (addr.isDefaultShipping = false));
    }
    if (isDefaultBilling) {
      user.addresses.forEach((addr) => (addr.isDefaultBilling = false));
    }

    delete updateFields.lat;
    delete updateFields.lng;
    Object.assign(address, updateFields, readPin(req.body, { label: "address pin" }) || {});
    if (typeof isDefaultShipping !== "undefined") {
      address.isDefaultShipping = Boolean(isDefaultShipping);
    }
    if (typeof isDefaultBilling !== "undefined") {
      address.isDefaultBilling = Boolean(isDefaultBilling);
    }

    await user.save();
    return res.status(200).json({
      message: "Address updated successfully",
      addresses: user.addresses,
    });
  } catch (error) {
    console.error("Error updating address:", error);
    return res.status(400).json({ message: error.message });
  }
};

// @desc    Delete an address
// @route   DELETE /api/auth/addresses/:addressId
// @access  Private
exports.deleteAddress = async (req, res) => {
  try {
    const userId = req.user._id || req.user.id || req.user.userId;
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const address = user.addresses.id(req.params.addressId);
    if (!address) {
      return res.status(404).json({ message: "Address not found" });
    }

    const wasDefaultShipping = address.isDefaultShipping;
    const wasDefaultBilling = address.isDefaultBilling;

    // Remove the address subdocument
    address.deleteOne();

    // Reassign defaults if a default address was deleted
    if (user.addresses.length > 0) {
      if (wasDefaultShipping && !user.addresses.some((a) => a.isDefaultShipping)) {
        user.addresses[0].isDefaultShipping = true;
      }
      if (wasDefaultBilling && !user.addresses.some((a) => a.isDefaultBilling)) {
        user.addresses[0].isDefaultBilling = true;
      }
    }

    await user.save();
    return res.status(200).json({
      message: "Address deleted successfully",
      addresses: user.addresses,
    });
  } catch (error) {
    console.error("Error deleting address:", error);
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Internal server error" });
  }
};
