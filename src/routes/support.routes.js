const express = require("express");
const router = express.Router();
const {
  createSupportCase,
  getSupportCaseById,
  addCaseComment,
} = require("../controllers/support.controller");
const { protect } = require("../middleware/auth.middleware");

router.use(protect); // Require JWT authentication

router.post("/cases", createSupportCase);
router.get("/cases/:id", getSupportCaseById);
router.post("/cases/:id/comments", addCaseComment);

module.exports = router;