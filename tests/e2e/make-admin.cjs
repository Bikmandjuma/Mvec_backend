// Creates the e2e super admin through the app's own User model (MySQL).
require("dotenv").config({ quiet: true });
const bcrypt = require("bcryptjs");
const User = require("../../src/models/User");

(async () => {
  await User.create({
    Fullname: "E2E Admin", email: process.env.E2E_ADMIN_EMAIL, password: await bcrypt.hash(process.env.E2E_ADMIN_PASSWORD, 10),
    gender: "other", phone: "0788300099", role: "super_admin",
  });
  await require("../../src/database").sequelize.close();
})().catch((e) => { console.error("make-admin failed:", e.message); process.exit(1); });
