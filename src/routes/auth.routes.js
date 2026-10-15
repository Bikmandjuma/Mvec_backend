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

router.get("/me", auth.getMe);
router.patch("/profile", auth.updateProfile);
router.delete("/avatar", auth.removeAvatar);
router.post("/logout-all", auth.logoutAll);

router.route("/addresses").get(auth.getAddresses).post(auth.addAddress);
router.route("/addresses/:addressId").put(auth.updateAddress).delete(auth.deleteAddress);
router.post("/change-password", auth.changePassword);

module.exports = router;