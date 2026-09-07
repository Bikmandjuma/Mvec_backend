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

router.get("/me", (req, res) => {
  const userResponse = {
    _id: req.user._id,
    Fullname: req.user.Fullname,
    email: req.user.email,
    role: req.user.role,
    phone: req.user.phone,
    gender: req.user.gender,
    companyName: req.user.companyName,
  };
  return res.status(200).json({ user: userResponse });
});

router.route("/addresses").get(auth.getAddresses).post(auth.addAddress);
router.route("/addresses/:addressId").put(auth.updateAddress).delete(auth.deleteAddress);

module.exports = router;