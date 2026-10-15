const express = require("express");
const router = express.Router();
const {
  addStaffMember,
  getStoreStaff,
  updateStaffMember,
  removeStaffMember,
  resetStaffPassword,
  getStaffActivity,
} = require("../controllers/staff.controller");

const { protect, authorize } = require("../middleware/auth.middleware");

router.use(protect);
router.use(authorize("vendor"));

router.route("/")
  .post(addStaffMember)
  .get(getStoreStaff);

router.get("/activity", getStaffActivity);
router.post("/:id/password", resetStaffPassword);

router.route("/:id")
  .put(updateStaffMember)
  .delete(removeStaffMember);

module.exports = router;