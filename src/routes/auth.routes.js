const express = require("express");
const router = express.Router();
const auth = require("../controllers/auth.controller");

// Route for user registration
router.post("/register", auth.registerUser);
router.post("/login", auth.loginUser);
router.post("/google-login", auth.googleLogin);

router.post("/forgot-password", auth.forgotPassword);
router.post("/reset-password/:token", auth.resetPassword);

const { protect } = require("../middleware/auth.middleware");

router.use(protect);

router.route("/addresses").get(auth.getAddresses).post(auth.addAddress);
router.route("/addresses/:addressId").put(auth.updateAddress).delete(auth.deleteAddress);

module.exports = router;