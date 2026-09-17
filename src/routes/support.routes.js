const express = require("express");
const router = express.Router();
const {
  createSupportCase,
  listSupportCases,
  getSupportCaseById,
  addCaseComment,
  updateSupportCaseStatus,
} = require("../controllers/support.controller");
const { protect } = require("../middleware/auth.middleware");

router.use(protect); // Require JWT authentication

router.post("/cases", createSupportCase);
router.get("/cases", listSupportCases);
router.get("/cases/:id", getSupportCaseById);
router.post("/cases/:id/comments", addCaseComment);
router.patch("/cases/:id/status", updateSupportCaseStatus);

module.exports = router;