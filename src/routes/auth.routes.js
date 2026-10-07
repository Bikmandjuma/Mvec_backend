const express = require("express");
const router = express.Router();
const auth = require("../controllers/auth.controller");

// Route for user registration
router.post("/register", auth.registerUser);
router.post("/login", auth.loginUser);
router.post("/google-login", auth.googleLogin);

// Phone OTP verification (phone-based registration & passwordless login)
router.post("/send-otp", auth.sendOtp);
router.post("/verify-otp", auth.verifyOtp);

router.post("/forgot-password", auth.forgotPassword);
router.post("/reset-password/:token", auth.resetPassword);

const { protect } = require("../middleware/auth.middleware");

router.use(protect);

router.get("/me", async (req, res) => {
  try {
    const Staff = require("../models/Staff");
    const staffMember = await Staff.findOne({
      $or: [{ user: req.user._id }, { user_id: req.user._id }],
      status: "ACTIVE",
    }).populate("store");

    const permissions = staffMember ? (staffMember.permissions?.toObject?.() || staffMember.permissions || {}) : {};
    const permissionsList = Object.entries(permissions).filter(([, v]) => v).map(([k]) => k);
    const storeId = staffMember ? (staffMember.store?._id || staffMember.store) : null;

    const userResponse = {
      _id: req.user._id,
      Fullname: req.user.Fullname,
      email: req.user.email,
      role: req.user.role,
      phone: req.user.phone,
      gender: req.user.gender,
      companyName: req.user.companyName,
      lastPasswordChangeAt: req.user.lastPasswordChangeAt,
      isStaff: Boolean(staffMember),
      isVendorStaff: Boolean(staffMember),
      storeId: storeId ? storeId.toString() : null,
      store_id: storeId ? storeId.toString() : null,
      staffRole: staffMember ? staffMember.role : null,
      staff_role: staffMember ? staffMember.role : null,
      permissions: permissionsList,
      permissionsMap: permissions,
    };
    return res.status(200).json({ user: userResponse });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

router.route("/addresses").get(auth.getAddresses).post(auth.addAddress);
router.route("/addresses/:addressId").put(auth.updateAddress).delete(auth.deleteAddress);
router.post("/change-password", auth.changePassword);

module.exports = router;