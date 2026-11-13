const sharp = require("sharp");

const FORMATS = { "image/jpeg": "jpeg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };

/**
 * Re-saves an image without its hidden metadata (EXIF: GPS location, camera,
 * date; XMP; comments). Phone photos often carry the exact place they were
 * taken, e.g. a seller's home. JPEGs are first turned the right way up (the
 * EXIF orientation is applied before it is dropped). Same format as before.
 */
async function stripImageMetadata(buffer, mime) {
  const format = FORMATS[mime];
  if (!format) return buffer;
  const animated = mime === "image/gif" || mime === "image/webp";
  let image = sharp(buffer, { animated, failOn: "error" });
  if (mime === "image/jpeg") image = image.rotate();
  // sharp writes no metadata unless asked to (no .withMetadata()).
  return image.toFormat(format, format === "jpeg" ? { quality: 90, mozjpeg: true } : {}).toBuffer();
}

module.exports = { stripImageMetadata };
