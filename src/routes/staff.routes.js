const express = require("express");
const router = express.Router();
const {
  addStaffMember,
  getStoreStaff,
  updateStaffMember,
  removeStaffMember,
} = require("../controllers/staff.controller");

const { protect, authorize } = require("../middleware/auth.middleware");

router.use(protect);
router.use(authorize("vendor"));

router.route("/")
  .post(addStaffMember)
  .get(getStoreStaff);

router.route("/:id")
  .put(updateStaffMember)
  .delete(removeStaffMember);

module.exports = router;