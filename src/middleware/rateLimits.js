// Request limits for endpoints attackers like to hammer: guessing passwords
// or codes, creating accounts, and spamming payment prompts or orders.
// Limits are per client IP (set TRUST_PROXY=1 behind a load balancer so the
// real client IP is used). Tests run with NODE_ENV=test and skip the limits;
// RATE_LIMITS=off does the same for local end-to-end runs (never in production).
const rateLimit = require("express-rate-limit");

const make = (windowMinutes, limit, message) =>
  rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skip: () => process.env.NODE_ENV === "test" || (process.env.RATE_LIMITS === "off" && process.env.NODE_ENV !== "production"),
    message: { message },
  });

module.exports = {
  // Wrong passwords: 10 tries per 15 minutes.
  login: make(15, 10, "Too many sign-in attempts. Wait 15 minutes and try again."),
  // Account creation: 5 per hour from one connection.
  register: make(60, 5, "Too many accounts created from this connection. Try again later."),
  // Codes sent by SMS or email cost money and can be abused: 5 per 15 minutes.
  sendCode: make(15, 5, "Too many codes requested. Wait 15 minutes and try again."),
  // Code guessing: 10 per 15 minutes on top of the per-code attempt limit.
  verifyCode: make(15, 10, "Too many attempts. Wait 15 minutes and try again."),
  // Payment prompts and orders: 20 per 10 minutes.
  payment: make(10, 20, "Too many payment attempts. Wait a few minutes and try again."),
  checkout: make(10, 20, "Too many orders placed in a short time. Wait a few minutes and try again."),
  // Reviews, problem reports and similar writes.
  write: make(10, 30, "You are doing that too often. Wait a few minutes and try again."),
};
