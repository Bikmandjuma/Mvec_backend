// src/utils/momo.util.js

/**
 * Validates and formats Rwandan phone numbers.
 * Converts local formats (e.g., 078XXXXXXX) to international format (25078XXXXXXX).
 */
exports.formatRwandanPhone = (phone) => {
  if (!phone) return null;

  // Remove spaces, hyphens, and non-digit characters except leading '+'
  let cleaned = phone.toString().replace(/\s+|-/g, "");

  if (cleaned.startsWith("+250")) {
    cleaned = cleaned.substring(1);
  } else if (cleaned.startsWith("0")) {
    cleaned = "250" + cleaned.substring(1);
  }

  // Must be 12 digits: 250 7X XXX XXXX
  const regex = /^2507[2389]\d{7}$/;
  if (!regex.test(cleaned)) {
    return null;
  }

  // Detect Carrier
  const prefix = cleaned.substring(3, 5); // Extracts '78', '79', '73', etc.
  let provider = "UNKNOWN";

  if (prefix === "78" || prefix === "79") {
    provider = "MTN";
  } else if (prefix === "73" || prefix === "72") {
    provider = "AIRTEL";
  }

  return {
    formattedNumber: cleaned, // e.g., "250788123456"
    localNumber: "0" + cleaned.substring(3), // e.g., "0788123456"
    provider // "MTN" or "AIRTEL"
  };
};