const express = require("express");
const router = express.Router();
const c = require("../controllers/quote.controller");
const { protect, authorize, requireOnboarded } = require("../middleware/auth.middleware");
const { checkStaffPermission } = require("../middleware/staff.middleware");
const { checkSupplierPermission } = require("../middleware/supplierTeam.middleware");

const vendor = [protect, authorize("vendor", "super_admin"), checkStaffPermission("canManageOrders")];
const supplierRead = [protect, authorize("supplier"), requireOnboarded];
const supplierWrite = [...supplierRead, checkSupplierPermission("supply")];

// Vendors post what they need and pick a quote.
router.post("/requests", ...vendor, requireOnboarded, c.createRequest);
router.get("/requests/mine", ...vendor, c.myRequests);
router.post("/requests/:id/cancel", ...vendor, c.cancelRequest);
router.post("/:quoteId/accept", ...vendor, c.acceptQuote);

// Suppliers see open requests and quote on them.
router.get("/open", ...supplierRead, c.openRequests);
router.get("/mine", ...supplierRead, c.myQuotes);
router.post("/requests/:id/quotes", ...supplierWrite, c.submitQuote);
router.post("/:quoteId/withdraw", ...supplierWrite, c.withdrawQuote);

// Admins can follow every request.
router.get("/admin/requests", protect, authorize("super_admin"), c.adminList);

module.exports = router;
