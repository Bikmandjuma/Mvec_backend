const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const path = require("path");
const dotenv = require("dotenv");
const User = require("./src/models/User");

// Ensure .env is resolved correctly regardless of execution directory
dotenv.config({ path: path.resolve(__dirname, ".env") });

const seedAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    // Hash current password from process.env
    const hashedPassword = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);

    // Object containing updated details
    const adminData = {
      Fullname: "Admin",
      email: process.env.ADMIN_EMAIL,
      password: hashedPassword,
      gender: "male",
      phone: "0788888880",
      role: "super_admin",
    };

    // Find super_admin and update, or create if missing
    const updatedAdmin = await User.findOneAndUpdate(
      { role: "super_admin" },
      adminData,
      {
        new: true,
        upsert: true,
        runValidators: true,
      }
    );

    console.log("Admin user updated/seeded successfully:");
    console.log(updatedAdmin);
  } catch (error) {
    console.error("Error seeding admin user:", error);
  } finally {
    await mongoose.disconnect();
  }
};

seedAdmin();