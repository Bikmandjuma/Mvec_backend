const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const express = require("express");
const User = require("../models/User");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

exports.registerUser = async (req, res) => {
  try {
    const { Fullname, email, password, gender, phone, role, companyName } =
      req.body;

    if (!Fullname || !email || !password || !gender || !phone || !role) {
      return res.status(400).json({ message: "All fields are required" });
    } else if (role == "vendor" && !companyName) {
      return res.status(400).json({ message: "Company name is required" });
    }

    // Check if the user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create a new user
    const newUser = new User({
      Fullname,
      email,
      password: hashedPassword,
      gender,
      phone,
      role,
      companyName: role === "vendor" ? companyName : undefined, // Only set companyName if role is vendor
    });

    // Save the user to the database
    await newUser.save();

    res
      .status(201)
      .json({ message: "User registered successfully", user: newUser });
  } catch (error) {
    console.error("Error registering user:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.loginUser = async (req, res) => {
  try {
    const { email, phone, password } = req.body;

    if ((!email && !phone) || !password) {
      return res
        .status(400)
        .json({ message: "Email or phone and password are required" });
    }

    const identifierQuery = email
      ? { email: email.trim().toLowerCase() }
      : { phone: phone.trim() };

    const user = await User.findOne({
      $or: [identifierQuery],
    });

    if (!user) {
      return res
        .status(400)
        .json({ message: "Invalid (email or phone) or password)" });
    }

    if (!user.password || !user.phone) {
      return res.status(400).json({
        message:
          "This account was created using Google Sign-In. Please log in with Google.",
      });
    }

    // Compare the provided password with the hashed password in the database
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

    // Generate a JWT token for the authenticated user
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: "1d",
    });

    // 6. Return response excluding sensitive password hash
    const userResponse = {
      _id: user._id,
      Fullname: user.Fullname,
      email: user.email,
      role: user.role,
      phone: user.phone,
      gender: user.gender,
    };

    // 7. Return the response with the token
    res.status(200).json({
      message: "Login successful",
      user: userResponse,
      token,
    });

  } catch (error) {
    console.error("Error logging in user:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

exports.googleLogin = async (req, res) => {
  try {
    const { idToken, role } = req.body;

    if (!idToken) {
      return res.status(400).json({ message: "Token ID is required" });
    }

    // Verify the token with Google
    const ticket = await client.verifyIdToken({
      idToken: idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const { email, name, sub: googleId } = payload;

    // Check if the user already exists
    let user = await User.findOne({ email });

    if (!user) {
      // If the user doesn't exist, create a new user
      user = new User({
        Fullname: name,
        email,
        googleId,
        role, // Assign the role from the request body
      });
      await user.save();
    } else if (!user.googleId) {
      // Link Google ID if user previously registered with email/password
      user.googleId = googleId;
      await user.save();
    }

    // Generate a JWT token for the authenticated user
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: "1d",
    });

    // 4. Return sanitized user data
    const userResponse = {
      _id: user._id,
      Fullname: user.Fullname,
      email: user.email,
      role: user.role,
      phone: user.phone || null,
      gender: user.gender || null,
    };

    res.status(200).json({
      message: "Login successful",
      user: userResponse,
      token,
    });
  } catch (error) {
    console.error("Error logging in with Google:", error);
    res.status(500).json({ message: "Internal server error" });
  }
};


// Helper: Configure Nodemailer transporter
const sendResetEmail = async (toEmail, resetUrl) => {
  const transporter = nodemailer.createTransport({
    service: "Gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS, // App Password from Google Account
    },
  });

  await transporter.sendMail({
    from: `"MVEC Support" <${process.env.EMAIL_USER}>`,
    to: toEmail,
    subject: "Password Reset Request",
    html: `
      <h2>Password Reset Request</h2>
      <p>You requested a password reset for your MVEC account. Click the button below to set a new password:</p>
      <a href="${resetUrl}" style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; display: inline-block; border-radius: 5px;">Reset Password</a>
      <p>Or copy and paste this link into your browser:</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
      <p><strong>Note:</strong> This link is valid for 15 minutes only. If you did not request this, please ignore this email.</p>
    `,
  });
};


// 1. FORGOT PASSWORD CONTROLLER
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const user = await User.findOne({ email: email.toLowerCase() });

    // Security best practice: Always return generic message to prevent account enumeration
    if (!user) {
      return res.status(200).json({ message: "If an account exists with that email, a reset link has been sent." });
    }

    // Block Google OAuth users from password reset
    if (!user.password && user.googleId) {
      return res.status(400).json({
        message: "This account was created using Google Sign-In. Please log in with Google.",
      });
    }

    // Generate unhashed random token for URL
    const resetToken = crypto.randomBytes(32).toString("hex");
    console.log("Generated Reset Token:", resetToken); // Debugging line

    // Hash token before saving to database (SHA-256)
    user.resetPasswordToken = crypto.createHash("sha256").update(resetToken).digest("hex");
    user.resetPasswordExpires = Date.now() + 15 * 60 * 1000; // 15-minute expiration

    await user.save();

    // Construct reset link for the React frontend
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password/${resetToken}`;

    // ─── NESTED EMAIL TRY...CATCH STARTS HERE ──────────────────────────────
    try {
      await sendResetEmail(user.email, resetUrl);
      return res.status(200).json({ 
        message: "If an account exists with that email, a reset link has been sent." 
      });
    } catch (emailError) {
      console.error("Nodemailer Error:", emailError.message);
      
      // Clear the reset fields in DB so no invalid token remains if sending fails
      user.resetPasswordToken = undefined;
      user.resetPasswordExpires = undefined;
      await user.save();

      return res.status(500).json({ 
        message: "Could not send reset email. Please try again later." 
      });
    }
    // ─── NESTED EMAIL TRY...CATCH ENDS HERE ────────────────────────────────

  } catch (error) {
    console.error("Forgot Password Error:", error);
    return res.status(500).json({ message: "Failed to process request" });
  }
};

// 2. RESET PASSWORD CONTROLLER
exports.resetPassword = async (req, res) => {
  try {
    const { token } = req.params;
    const { newPassword } = req.body;

    if (!newPassword) {
      return res.status(400).json({ message: "New password is required" });
    }

    // Hash the token from the URL parameter to match DB record
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    // Search for user with matching token that hasn't expired yet
    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({ message: "Invalid or expired reset token" });
    }

    // Hash new password and clear token fields
    user.password = await bcrypt.hash(newPassword, 10);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;

    await user.save();

    return res.status(200).json({ message: "Password reset successful! You can now log in with your new password." });
  } catch (error) {
    console.error("Reset Password Error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};


exports.addAddress = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId || req.user.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const {
      type,
      country,
      provinceState,
      cityDistrict,
      street,
      building,
      apartment,
      postalCode,
      phone,
      deliveryInstructions,
      isDefaultShipping,
      isDefaultBilling,
    } = req.body;

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
      street,
      building,
      apartment,
      postalCode,
      phone,
      deliveryInstructions,
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
// @route   GET /api/users/addresses
// @access  Private
exports.getAddresses = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId || req.user.id).select("addresses");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({ addresses: user.addresses });
  } catch (error) {
    console.error("Error fetching addresses:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// @desc    Update an existing address
// @route   PUT /api/users/addresses/:addressId
// @access  Private
exports.updateAddress = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId || req.user.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const address = user.addresses.id(req.params.addressId);
    if (!address) {
      return res.status(404).json({ message: "Address not found" });
    }

    const { isDefaultShipping, isDefaultBilling } = req.body;

    // Handle default flag switches across other stored addresses
    if (isDefaultShipping) {
      user.addresses.forEach((addr) => (addr.isDefaultShipping = false));
    }
    if (isDefaultBilling) {
      user.addresses.forEach((addr) => (addr.isDefaultBilling = false));
    }

    Object.assign(address, req.body);

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
// @route   DELETE /api/users/addresses/:addressId
// @access  Private
exports.deleteAddress = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId || req.user.id);
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
    return res.status(500).json({ message: "Internal server error" });
  }
};