const express = require("express");
const router = express.Router();
const c = require("../controllers/vendorPayoutAdmin.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// MVEC finance: seller withdrawal requests.
router.use(protect, authorize("super_admin"));
router.get("/", c.listVendorPayouts);
router.post("/:id/approve", c.approveVendorPayout);
router.post("/:id/mark-paid", c.markVendorPayoutPaid);
router.post("/:id/reject", c.rejectVendorPayout);

module.exports = router;
