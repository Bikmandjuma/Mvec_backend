const express = require("express");
const router = express.Router();
const disputeController = require("../controllers/dispute.controller");
const { protect, authorize } = require("../middleware/auth.middleware"); // Adjust middleware import path if needed

// Super Admin: list all dispute cases
router.get("/", protect, authorize("super_admin"), disputeController.adminListDisputes);

// Own dispute cases (raised by or involving the signed-in user)
router.get("/mine", protect, disputeController.listMyDisputes);

// One case with its timeline and what the requester may do next (buyer, seller or admin).
const cases = require("../services/disputeCase.service");
const run = (fn) => async (req, res) => {
  try { return res.status(200).json(await fn(req)); }
  catch (error) { return res.status(error.statusCode || 400).json({ message: error.message }); }
};
const write = require("../middleware/rateLimits").write;
router.get("/:disputeId/case", protect, run((req) => cases.getCase(req.params.disputeId, req.user)));
// Seller
router.post("/:disputeId/full-refund", protect, write, run(async (req) => ({ message: "Refunded in full. The buyer has been told.", data: await cases.sellerFullRefund(req.params.disputeId, req.user, req.body?.note) })));
router.post("/:disputeId/offer", protect, write, run(async (req) => ({ message: "Offer sent to the buyer.", data: await cases.sellerOffer(req.params.disputeId, req.user, req.body || {}) })));
// Buyer
router.post("/:disputeId/offer/accept", protect, write, run(async (req) => ({ message: "Offer accepted. Your refund is on its way.", data: await cases.buyerRespondOffer(req.params.disputeId, req.user, true) })));
router.post("/:disputeId/offer/decline", protect, write, run(async (req) => ({ message: "Offer declined. MVEC will review the case and decide.", data: await cases.buyerRespondOffer(req.params.disputeId, req.user, false) })));
router.post("/:disputeId/withdraw", protect, write, run(async (req) => ({ message: "Report withdrawn. The order continues as normal.", data: await cases.withdraw(req.params.disputeId, req.user, req.body?.note) })));
// Either side
router.post("/:disputeId/escalate", protect, write, run(async (req) => ({ message: "MVEC will review the case and decide.", data: await cases.escalate(req.params.disputeId, req.user, req.body?.reason) })));
// MVEC
router.post("/:disputeId/decide", protect, authorize("super_admin"), run(async (req) => ({ message: "Decision made. Both sides have been told.", data: await cases.decide(req.params.disputeId, req.user, req.body || {}) })));

// Open a dispute case for an order
router.post("/", protect, require("../middleware/rateLimits").write, disputeController.openDispute);

// Attach chat evidence/documents to dispute case
router.post("/:disputeId/evidence", protect, disputeController.submitEvidence);

// Admin binding arbitration execution
router.post(
  "/:disputeId/arbitrate",
  protect,
  authorize("super_admin"),
  disputeController.resolveArbitration
);

module.exports = router;