// Returns after delivery (services/returns.service.js).
const express = require("express");
const returns = require("../services/returns.service");
const { protect, authorize } = require("../middleware/auth.middleware");
const { checkStaffPermission } = require("../middleware/staff.middleware");
const { write } = require("../middleware/rateLimits");

const router = express.Router();
const run = (fn) => async (req, res) => {
  try {
    return res.status(200).json(await fn(req));
  } catch (error) {
    if (!error.statusCode) console.error("Returns:", error);
    return res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Something went wrong with this return. Please try again." });
  }
};
const seller = [authorize("vendor", "supplier", "super_admin"), checkStaffPermission("canManageOrders")];

router.use(protect);

// Buyers
router.get("/orders/:orderId/eligibility", run((req) => returns.eligibility(req.user, req.params.orderId)));
router.post("/", write, run((req) => returns.create(req.user, req.body || {})));
router.get("/mine", run((req) => returns.mine(req.user)));
router.post("/:id/cancel", write, run((req) => returns.cancel(req.user, req.params.id)));
router.post("/:id/escalate", write, run((req) => returns.escalate(req.user, req.params.id, req.body || {})));

// Sellers (and their staff who manage orders)
router.get("/seller", ...seller, run((req) => returns.forSeller(req.user, req, req.query)));
router.post("/:id/approve", ...seller, run((req) => returns.approve(req.user, req, req.params.id, req.body || {})));
router.post("/:id/reject", ...seller, run((req) => returns.reject(req.user, req, req.params.id, req.body || {})));
router.post("/:id/received", ...seller, run((req) => returns.received(req.user, req, req.params.id, req.body || {})));
router.post("/:id/refund", ...seller, run((req) => returns.refundWithoutReturn(req.user, req, req.params.id)));

// Ikiguzi
router.get("/admin", authorize("super_admin"), run((req) => returns.forAdmin(req.query)));
router.post("/:id/decide", authorize("super_admin"), run((req) => returns.decide(req.user, req.params.id, req.body || {})));

router.get("/:id", run((req) => returns.getOne(req.user, req.params.id)));

module.exports = router;
