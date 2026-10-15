// Creates the MVEC super admin, or updates the existing one, in MySQL.
//
//   npm run seed                                  uses ADMIN_EMAIL / ADMIN_PASSWORD from .env
//   npm run seed -- admin@example.com 'S3cret…'   uses the email and password given here
//
// Then sign in at /login with that email and password; admins land on /admin.
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, ".env"), quiet: true });
const bcrypt = require("bcryptjs");
const User = require("./src/models/User");

const PLACEHOLDER = "your_admin_password_here";

(async () => {
  const email = String(process.argv[2] || process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(process.argv[3] || process.env.ADMIN_PASSWORD || "");
  if (!email || !email.includes("@")) throw new Error("Give the admin email: npm run seed -- you@example.com 'a strong password' (or set ADMIN_EMAIL in .env).");
  if (!password || password === PLACEHOLDER) throw new Error("Choose a real admin password: npm run seed -- you@example.com 'a strong password' (or set ADMIN_PASSWORD in .env).");
  if (password.length < 10 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) throw new Error("Use at least 10 characters with letters and numbers for the admin password.");

  const hashed = await bcrypt.hash(password, 10);
  const taken = await User.findOne({ email });
  if (taken && taken.role !== "super_admin") throw new Error(`${email} already belongs to a ${taken.role} account. Use another email for the admin.`);

  const existing = taken || (await User.findOne({ role: "super_admin" }).sort({ createdAt: 1 }));
  if (existing) {
    existing.email = email;
    existing.password = hashed;
    existing.status = "ACTIVE";
    await existing.save();
    console.log(`Admin updated: ${email}. Sign in at /login.`);
  } else {
    await User.create({ Fullname: "MVEC Admin", email, password: hashed, gender: "other", phone: "0788888880", role: "super_admin", status: "ACTIVE" });
    console.log(`Admin created: ${email}. Sign in at /login.`);
  }
  await require("./src/database").sequelize.close();
})().catch(async (error) => {
  console.error(`Could not set up the admin: ${error.message}`);
  await require("./src/database").sequelize.close().catch(() => {});
  process.exit(1);
});
