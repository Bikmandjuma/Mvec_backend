// middlewares/verifyAirtelSignature.js
const crypto = require("crypto");

module.exports = (req, res, next) => {
  if (process.env.NODE_ENV !== "production") return next();

  const signature = req.headers["x-airtel-signature"];
  const secretKey = process.env.AIRTEL_SECRET_KEY;

  if (!signature) {
    return res.status(401).json({ message: "Missing Airtel signature header." });
  }

  const expectedSignature = crypto
    .createHmac("sha256", secretKey)
    .update(JSON.stringify(req.body))
    .digest("hex");

  if (signature !== expectedSignature) {
    return res.status(403).json({ message: "Invalid webhook signature." });
  }

  next();
};