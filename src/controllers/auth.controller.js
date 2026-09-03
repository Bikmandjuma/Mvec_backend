const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const express = require("express");
const User = require("../models/User");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const crypto = require("crypto");
const nodemailer = require("nodemailer");

// ─── HELPER: GOOGLE OAUTH CLIENT ─────────────────────────────────────────────
const getGoogleClient = () => {
  return new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
};

// ─── REGISTER USER ───────────────────────────────────────────────────────────
exports.registerUser = async (req, res) => {
  try {
    const { Fullname, email, password, gender, phone, role, companyName } =
      req.body;

    if (!Fullname || !email || !password || !gender || !phone || !role) {
      return res.status(400).json({ message: "All fields are required" });
    } else if (role === "vendor" && !companyName) {
      return res.status(400).json({ message: "Company name is required" });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const normalizedPhone = phone.trim();

    // Check if the user already exists by email or phone
    const existingUser = await User.findOne({
      $or: [{ email: normalizedEmail }, { phone: normalizedPhone }],
    });

    if (existingUser) {
      const isEmailMatch = existingUser.email === normalizedEmail;
      return res.status(400).json({
        message: isEmailMatch
          ? "User with this email already exists"
          : "User with this phone number already exists",
      });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create a new user
    const newUser = new User({
      Fullname: Fullname.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      gender,
      phone: normalizedPhone,
      role,
      companyName: role === "vendor" ? companyName.trim() : undefined,
    });

    // Save the user to the database
    await newUser.save();

    // Return response excluding sensitive password hash
    const userResponse = {
      _id: newUser._id,
      Fullname: newUser.Fullname,
      email: newUser.email,
      role: newUser.role,
      phone: newUser.phone,
      gender: newUser.gender,
      companyName: newUser.companyName,
    };

    return res.status(201).json({
      message: "User registered successfully",
      user: userResponse,
    });
  } catch (error) {
    console.error("Error registering user:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// ─── LOGIN USER ──────────────────────────────────────────────────────────────
exports.loginUser = async (req, res) => {
  try {
    const { email, phone, password } = req.body;

    if ((!email && !phone) || !password) {
      return res
        .status(400)
        .json({ message: "Email or phone and password are required" });
    }

    const normalizedEmail = email ? email.trim().toLowerCase() : null;
    const normalizedPhone = phone ? phone.trim() : null;

    const user = await User.findOne(
      normalizedEmail && normalizedPhone
        ? { $or: [{ email: normalizedEmail }, { phone: normalizedPhone }] }
        : normalizedEmail
        ? { email: normalizedEmail }
        : { phone: normalizedPhone }
    );

    if (!user) {
      return res.status(400).json({ message: "Invalid email/phone or password" });
    }

    // Check if user is a Google-only account without password
    if (!user.password && user.googleId) {
      return res.status(400).json({
        message:
          "This account was created using Google Sign-In. Please log in with Google.",
      });
    }

    // Compare the provided password with the hashed password in the database
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(400).json({ message: "Invalid email/phone or password" });
    }

    // Generate a JWT token for the authenticated user
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: "1d",
    });

    // Return response excluding sensitive password hash
    const userResponse = {
      _id: user._id,
      Fullname: user.Fullname,
      email: user.email,
      role: user.role,
      phone: user.phone,
      gender: user.gender,
      companyName: user.companyName,
    };

    return res.status(200).json({
      message: "Login successful",
      user: userResponse,
      token,
    });
  } catch (error) {
    console.error("Error logging in user:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// ─── GOOGLE LOGIN ────────────────────────────────────────────────────────────
exports.googleLogin = async (req, res) => {
  try {
    const idToken = req.body.idToken || req.body.token;
    const { role } = req.body;

    if (!idToken) {
      return res.status(400).json({ message: "Token ID is required" });
    }

    // Verify the token with Google
    const client = getGoogleClient();
    const ticket = await client.verifyIdToken({
      idToken: idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const { email, name, sub: googleId } = payload;

    // Check if the user already exists
    let user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      // If the user doesn't exist, create a new user
      user = new User({
        Fullname: name,
        email: email.toLowerCase(),
        googleId,
        role: role || "buyer",
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

    // Return sanitized user data
    const userResponse = {
      _id: user._id,
      Fullname: user.Fullname,
      email: user.email,
      role: user.role,
      phone: user.phone || null,
      gender: user.gender || null,
    };

    return res.status(200).json({
      message: "Login successful",
      user: userResponse,
      token,
    });
  } catch (error) {
    console.error("Error logging in with Google:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// ─── HELPER: NODEMAILER TRANSPORTER ──────────────────────────────────────────
const getTransporter = () => {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;

  if (!user || !pass) {
    throw new Error(
      "Email credentials are not configured. Please set EMAIL_USER and EMAIL_PASS environment variables."
    );
  }

  // If EMAIL_HOST is provided, use custom SMTP options; otherwise fallback to Gmail service
  if (process.env.EMAIL_HOST) {
    return nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: Number(process.env.EMAIL_PORT) || 587,
      secure: process.env.EMAIL_SECURE === "true" || process.env.EMAIL_PORT === "465",
      auth: { user, pass },
    });
  }

  return nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || "Gmail",
    auth: { user, pass },
  });
};

const sendResetEmail = async (toEmail, resetUrl) => {
  const transporter = getTransporter();
  const fromAddress = process.env.EMAIL_FROM || process.env.EMAIL_USER;

  await transporter.sendMail({
    from: `"MVEC Support" <${fromAddress}>`,
    to: toEmail,
    subject: "Password Reset Request",
    text: `You requested a password reset for your MVEC account.\n\nPlease click the following link to reset your password (valid for 15 minutes):\n${resetUrl}\n\nIf you did not request this, please ignore this email.`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          .container { font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px; }
          .header { text-align: center; border-bottom: 1px solid #eee; padding-bottom: 15px; margin-bottom: 20px; }
          .btn { background-color: #4CAF50; color: #ffffff !important; padding: 12px 24px; text-decoration: none; display: inline-block; border-radius: 5px; font-weight: bold; margin: 15px 0; }
          .footer { font-size: 12px; color: #888; margin-top: 25px; border-top: 1px solid #eee; padding-top: 15px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h2>Password Reset Request</h2>
          </div>
          <p>Hello,</p>
          <p>You requested a password reset for your MVEC account. Click the button below to set a new password:</p>
          <p style="text-align: center;">
            <a href="${resetUrl}" class="btn" style="color: #ffffff;">Reset Password</a>
          </p>
          <p>Or copy and paste this link into your browser:</p>
          <p><a href="${resetUrl}">${resetUrl}</a></p>
          <p><strong>Note:</strong> This link is valid for 15 minutes only. If you did not request this, please ignore this email.</p>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} MVEC. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `,
  });
};

// Export assisting functions for unit tests
exports.getTransporter = getTransporter;
exports.sendResetEmail = sendResetEmail;

// ─── 1. FORGOT PASSWORD CONTROLLER ───────────────────────────────────────────
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || typeof email !== "string" || !email.trim()) {
      return res.status(400).json({ message: "Email is required" });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });

    // Consistent generic response message to prevent email enumeration
    const genericResponse = {
      message: "If an account exists with that email, a reset link has been sent.",
    };

    if (!user) {
      return res.status(200).json(genericResponse);
    }

    // Block Google OAuth users without local password from password reset
    if (!user.password && user.googleId) {
      return res.status(400).json({
        message: "This account was created using Google Sign-In. Please log in with Google.",
      });
    }

    // Generate unhashed random token for URL
    const resetToken = crypto.randomBytes(32).toString("hex");

    // Hash token before saving to database (SHA-256)
    user.resetPasswordToken = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");
    user.resetPasswordExpires = new Date(Date.now() + 15 * 60 * 1000); // 15-minute expiration

    await user.save({ validateBeforeSave: false });

    // Construct reset link for the React frontend safely
    const frontendUrl = (process.env.FRONTEND_URL || "http://localhost:3000").replace(/\/+$/, "");
    const resetUrl = `${frontendUrl}/reset-password/${resetToken}`;

    // Send email safely
    try {
      await sendResetEmail(user.email, resetUrl);
      return res.status(200).json(genericResponse);
    } catch (emailError) {
      console.error("Email Sending Error:", emailError.message);

      // Clear reset fields in DB so no invalid token remains if sending fails
      user.resetPasswordToken = undefined;
      user.resetPasswordExpires = undefined;
      await user.save({ validateBeforeSave: false });

      return res.status(500).json({
        message: "Could not send reset email. Please try again later.",
      });
    }
  } catch (error) {
    console.error("Forgot Password Error:", error);
    return res.status(500).json({ message: "Failed to process request" });
  }
};

// ─── 2. RESET PASSWORD CONTROLLER ────────────────────────────────────────────
exports.resetPassword = async (req, res) => {
  try {
    const { token } = req.params;
    const newPassword = req.body.newPassword || req.body.password;

    if (!token || typeof token !== "string" || !token.trim()) {
      return res.status(400).json({ message: "Reset token is required" });
    }

    if (!newPassword || typeof newPassword !== "string" || newPassword.length < 6) {
      return res.status(400).json({
        message: "Password is required and must be at least 6 characters long",
      });
    }

    // Hash the token from URL parameter to match DB record
    const hashedToken = crypto
      .createHash("sha256")
      .update(token.trim())
      .digest("hex");

    // Search for user with matching token that hasn't expired yet
    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!user) {
      return res
        .status(400)
        .json({ message: "Invalid or expired reset token" });
    }

    // Hash new password and clear token fields
    user.password = await bcrypt.hash(newPassword, 10);
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;

    await user.save();

    return res.status(200).json({
      message: "Password reset successful! You can now log in with your new password.",
    });
  } catch (error) {
    console.error("Reset Password Error:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// ─── 3. USER ADDRESSES ───────────────────────────────────────────────────────
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
    return res.status(500).json({ message: "Internal server error" });
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

    // Handle default flag switches across other stored addresses
    if (isDefaultShipping) {
      user.addresses.forEach((addr) => (addr.isDefaultShipping = false));
    }
    if (isDefaultBilling) {
      user.addresses.forEach((addr) => (addr.isDefaultBilling = false));
    }

    Object.assign(address, updateFields);
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
    return res.status(500).json({ message: "Internal server error" });
  }
};
