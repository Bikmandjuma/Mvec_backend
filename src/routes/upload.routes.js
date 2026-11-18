const express = require("express");
const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const multer = require("multer");
const { protect } = require("../middleware/auth.middleware");
const { checkStaffPermission } = require("../middleware/staff.middleware");
const { stripImageMetadata } = require("../utils/imageMetadata");
const User = require("../models/User");

const router = express.Router();
const uploadDir = path.resolve(__dirname, "../../uploads");
const MAX_FILE_SIZE = 8 * 1024 * 1024;
const MAX_AVATAR_SIZE = 3 * 1024 * 1024;
const MAX_FILES = 10;
// The declared type must match the file's first bytes, so a renamed script
// can't be stored as an "image".
const imageTypes = {
  "image/jpeg": { extension: ".jpg", matches: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/png": { extension: ".png", matches: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) },
  "image/gif": { extension: ".gif", matches: (b) => b.length >= 6 && ["GIF87a", "GIF89a"].includes(b.toString("ascii", 0, 6)) },
  "image/webp": { extension: ".webp", matches: (b) => b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
};

const receive = (maxSize, fields) => {
  const parse = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxSize, files: MAX_FILES } }).fields(fields);
  return (req, res, next) =>
    parse(req, res, (err) => {
      if (!err) return next();
      if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ message: `Each image must be ${maxSize / 1024 / 1024} MB or smaller.` });
      if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") return res.status(400).json({ message: `Upload no more than ${MAX_FILES} images at once.` });
      return res.status(400).json({ message: "The upload could not be read. Try again." });
    });
};

const filesOf = (req, ...fields) => fields.flatMap((field) => req.files?.[field] || []);

const isImage = (file) => Boolean(imageTypes[file.mimetype]?.matches(file.buffer));

/** Saves a checked image without its metadata and returns its public URL. sharp throws on a damaged image. */
async function saveImage(req, file, prefix = "") {
  const type = imageTypes[file.mimetype];
  const clean = await stripImageMetadata(file.buffer, file.mimetype);
  await fs.mkdir(uploadDir, { recursive: true });
  const name = `${prefix}${crypto.randomUUID()}${type.extension}`;
  await fs.writeFile(path.join(uploadDir, name), clean, { flag: "wx" });
  return `${req.protocol}://${req.get("host")}/uploads/${name}`;
}

function allowOnboardingOrProductUpload(req, res, next) {
  if (["vendor", "supplier", "super_admin"].includes(req.user?.role)) return next();
  return checkStaffPermission("canManageProducts")(req, res, next);
}

router.post("/images", protect, allowOnboardingOrProductUpload, receive(MAX_FILE_SIZE, [{ name: "images", maxCount: MAX_FILES }]), async (req, res) => {
  const files = filesOf(req, "images");
  if (!files.length) return res.status(400).json({ message: "Select at least one image to upload." });
  if (!files.every(isImage)) {
    return res.status(400).json({ message: "Only valid JPEG, PNG, WEBP, and GIF images are allowed." });
  }
  try {
    const urls = [];
    for (const file of files) urls.push(await saveImage(req, file));
    return res.status(201).json({ urls });
  } catch {
    return res.status(400).json({ message: "One of the images is damaged. Choose another and try again." });
  }
});

// Profile photo for any signed-in account (staff upload to their own account).
router.post("/avatar", protect, receive(MAX_AVATAR_SIZE, [{ name: "avatar", maxCount: 1 }, { name: "images", maxCount: 1 }]), async (req, res) => {
  const [file] = filesOf(req, "avatar", "images");
  if (!file) return res.status(400).json({ message: "Choose a photo to upload." });
  if (file.mimetype === "image/gif" || !isImage(file)) {
    return res.status(400).json({ message: "Use a JPEG, PNG or WEBP photo." });
  }
  let avatarUrl;
  try {
    avatarUrl = await saveImage(req, file, "avatar-");
  } catch {
    return res.status(400).json({ message: "That photo is damaged. Choose another and try again." });
  }
  await User.updateOne({ _id: (req.staffUser || req.user)._id }, { $set: { avatarUrl } });
  return res.status(201).json({ message: "Photo updated.", avatarUrl });
});


// Photos any signed-in buyer attaches (a return's proof of damage): public images, up to 5.
router.post("/photos", protect, require("../middleware/rateLimits").write, receive(MAX_FILE_SIZE, [{ name: "photos", maxCount: 5 }]), async (req, res) => {
  const files = filesOf(req, "photos");
  if (!files.length) return res.status(400).json({ message: "Choose a photo." });
  if (files.length > 5) return res.status(400).json({ message: "Add at most 5 photos." });
  if (!files.every(isImage)) return res.status(400).json({ message: "Photos must be JPG, PNG, GIF or WebP images." });
  try {
    const urls = [];
    for (const file of files) urls.push(new URL(await saveImage(req, file, "photo-")).pathname);
    return res.status(201).json({ urls });
  } catch {
    return res.status(400).json({ message: "A photo could not be read. Try another one." });
  }
});

// Private documents (a seller's ID and business papers, return photos stay public).
// Saved outside the public uploads folder; only the owner and admins can open them.
const privateDir = path.resolve(__dirname, "../../private-uploads");
const docTypes = {
  ...imageTypes,
  "application/pdf": { extension: ".pdf", matches: (b) => b.length >= 5 && b.toString("ascii", 0, 5) === "%PDF-" },
};
router.post("/documents", protect, receive(MAX_FILE_SIZE, [{ name: "documents", maxCount: 5 }]), async (req, res) => {
  if (!["vendor", "supplier", "super_admin"].includes(req.user.role)) return res.status(403).json({ message: "Only sellers and suppliers upload verification documents." });
  const files = filesOf(req, "documents");
  if (!files.length) return res.status(400).json({ message: "Choose a photo or PDF of the document." });
  if (files.some((f) => !docTypes[f.mimetype]?.matches(f.buffer))) return res.status(400).json({ message: "Documents must be photos (JPG, PNG, WebP) or PDF files." });
  try {
    await fs.mkdir(privateDir, { recursive: true });
    const saved = [];
    for (const file of files) {
      const type = docTypes[file.mimetype];
      const body = file.mimetype === "application/pdf" ? file.buffer : await stripImageMetadata(file.buffer, file.mimetype);
      const name = `${req.user.id}-${crypto.randomUUID()}${type.extension}`;
      await fs.writeFile(path.join(privateDir, name), body, { flag: "wx" });
      saved.push({ url: `/api/uploads/private/${name}`, name: String(file.originalname || "").slice(0, 120) });
    }
    return res.status(201).json({ documents: saved });
  } catch {
    return res.status(400).json({ message: "A photo could not be read. Try another one." });
  }
});

router.get("/private/:name", protect, async (req, res) => {
  const name = String(req.params.name);
  if (!/^[0-9a-f]{24}-[0-9a-f-]{36}\.(jpg|png|gif|webp|pdf)$/.test(name)) return res.status(404).json({ message: "Document not found." });
  const owner = name.slice(0, 24);
  if (req.user.role !== "super_admin" && String(req.user.id) !== owner) return res.status(404).json({ message: "Document not found." });
  res.set("Cache-Control", "private, no-store");
  return res.sendFile(path.join(privateDir, name), (err) => { if (err && !res.headersSent) res.status(404).json({ message: "Document not found." }); });
});

module.exports = router;
