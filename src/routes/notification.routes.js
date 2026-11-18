const express = require("express");
const router = express.Router();
const notification = require("../controllers/notification.controller");
const { protect, authorize } = require("../middleware/auth.middleware");

// Public create (for authenticated roles pushing system events) and self-management.
router.use(protect);

// Only admins send manual notifications; the system creates the rest.
router.post("/", authorize("super_admin"), notification.createNotification);
router.get("/mine", notification.listMyNotifications);
router.post("/read-all", notification.markAllRead);
router.patch("/:id/read", notification.markRead);

// Push: the app registers its device token after sign-in, and removes it on sign-out.
const push = require("../services/push.service");
const pushRun = (fn) => async (req, res) => {
  try { return res.status(200).json(await fn(req)); } catch (e) { return res.status(e.statusCode || 500).json({ message: e.statusCode ? e.message : "Could not update this device." }); }
};
router.post("/devices", pushRun((req) => push.register(req.user, req.body || {})));
router.delete("/devices", pushRun((req) => push.unregister(req.user, req.body?.token || req.query.token)));

// Admin oversight.
router.get("/", authorize("super_admin"), notification.adminListNotifications);

module.exports = router;
