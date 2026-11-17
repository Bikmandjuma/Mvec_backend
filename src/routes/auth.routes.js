const express = require("express");
const router = express.Router();
const auth = require("../controllers/auth.controller");
const addresses = require("../controllers/address.controller");
const wishlist = require("../controllers/wishlist.controller");
const limits = require("../middleware/rateLimits");

// Route for user registration
router.post("/register", limits.register, auth.registerUser);
router.post("/login", limits.login, auth.loginUser);
router.post("/google-login", limits.login, auth.googleLogin);

// Phone OTP verification (phone-based registration & passwordless login)
router.post("/send-otp", limits.sendCode, auth.sendOtp);
router.post("/verify-otp", limits.verifyCode, auth.verifyOtp);

// Guest checkout: prove the phone with a one-time code instead of signing up.
router.post("/guest/send-code", limits.sendCode, auth.guestSendCode);
router.post("/guest/verify", limits.verifyCode, auth.guestVerify);

router.post("/forgot-password", limits.sendCode, auth.forgotPassword);
router.post("/verify-reset-otp", limits.verifyCode, auth.verifyResetOtp);
router.post("/reset-password", limits.verifyCode, auth.resetPassword);
router.post("/reset-password/:token", limits.verifyCode, auth.resetPassword);

const { protect } = require("../middleware/auth.middleware");

router.use(protect);

router.get("/me", async (req, res) => {
  try {
    const user = await auth.getAuthenticatedUserResponse(req.user);
    return res.status(200).json({ user });
  } catch (error) {
    return res.status(500).json({ message: "Could not load the current account." });
  }
});
router.patch("/profile", auth.updateAccount);
router.delete("/avatar", auth.removeAvatar);
router.post("/logout-all", auth.logoutAll);

router.patch("/me", auth.updateProfile);
router.route("/wishlist").get(wishlist.getWishlist).post(wishlist.addToWishlist);
router.delete("/wishlist/:productId", wishlist.removeFromWishlist);

router.route("/addresses").get(addresses.getAddresses).post(addresses.addAddress);
router.route("/addresses/:addressId").put(addresses.updateAddress).delete(addresses.deleteAddress);
router.post("/change-password", limits.login, auth.changePassword);

module.exports = router;
