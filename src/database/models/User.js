const { DataTypes, primaryKey, withIds } = require("./_shared");

module.exports = (sequelize) => {
  const User = sequelize.define("User", {
    id: primaryKey(),
    Fullname: { type: DataTypes.STRING(150), allowNull: false },
    email: { type: DataTypes.STRING(190), allowNull: true, unique: true, set(v) { this.setDataValue("email", v ? String(v).trim().toLowerCase() : null); } },
    password: { type: DataTypes.STRING(255), allowNull: true },
    gender: { type: DataTypes.ENUM("male", "female", "other"), allowNull: true },
    phone: { type: DataTypes.STRING(20), allowNull: true, unique: true, validate: { isRwandanPhone(v) { if (v && !/^(\+250|0)?7[2389]\d{7}$/.test(v)) throw new Error(`${v} is not a valid phone number!`); } } },
    googleId: { type: DataTypes.STRING(64), allowNull: true, unique: true },
    email_verified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    role: { type: DataTypes.ENUM("buyer", "vendor", "supplier", "affiliate", "super_admin", "developer", "delivery"), allowNull: false, defaultValue: "buyer" },
    isSellerEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    status: { type: DataTypes.ENUM("ACTIVE", "SUSPEND", "BLOCK", "INVESTIGATE"), allowNull: false, defaultValue: "ACTIVE" },
    companyName: { type: DataTypes.STRING(150), allowNull: true },
    resetPasswordToken: { type: DataTypes.STRING(255), allowNull: true },
    resetPasswordExpires: { type: DataTypes.DATE, allowNull: true },
    isVendorStaff: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    lastPasswordChangeAt: { type: DataTypes.DATE, allowNull: true },
    // Seller / supplier onboarding profile.
    businessName: { type: DataTypes.STRING(150), allowNull: true, defaultValue: "" },
    description: { type: DataTypes.TEXT, allowNull: true },
    logoUrl: { type: DataTypes.STRING(500), allowNull: true, defaultValue: "" },
    category: { type: DataTypes.STRING(120), allowNull: true, defaultValue: "" },
    location: { type: DataTypes.JSON, allowNull: true },
    isOnboarded: { type: DataTypes.BOOLEAN, allowNull: true },
    verificationStatus: { type: DataTypes.ENUM("UNVERIFIED", "PENDING", "VERIFIED", "REJECTED"), allowNull: true },
    avatarUrl: { type: DataTypes.STRING(500), allowNull: true, defaultValue: "" },
    resetPasswordCode: { type: DataTypes.STRING(255), allowNull: true },
    resetPasswordCodeExpires: { type: DataTypes.DATE, allowNull: true },
    resetPasswordAttempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    isSupplierStaff: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  }, {
    tableName: "users",
    timestamps: true,
    // Same rules as the Mongoose schema.
    validate: {
      // Gender is optional ("Prefer not to say"); staff accounts are set up by invitation.
      requiredUnlessGoogleOrStaff() {
        if (this.googleId || this.isVendorStaff || this.isSupplierStaff) return;
        if (!this.password) throw new Error("Password is required");
        if (!this.phone) throw new Error("Phone is required");
      },
      companyForVendors() {
        if (this.role === "vendor" && !this.isVendorStaff && !this.companyName) throw new Error("Company name is required");
      },
    },
    defaultScope: { attributes: { exclude: ["isVendorStaff", "isSupplierStaff", "resetPasswordCode", "resetPasswordCodeExpires", "resetPasswordAttempts"] } }, // select:false in Mongoose
    hooks: {
      // Same role-based defaults as the Mongoose schema.
      beforeValidate(row) {
        const seller = ["vendor", "supplier"].includes(row.role);
        if (row.isOnboarded === null || row.isOnboarded === undefined) row.isOnboarded = !seller;
        if (!row.verificationStatus) row.verificationStatus = seller ? "UNVERIFIED" : "VERIFIED";
      },
    },
  });

  User.associate = (m) => {
    User.hasMany(m.UserAddress, { as: "addresses", foreignKey: "userId", onDelete: "CASCADE" });
    User.hasMany(m.UserWishlistItem, { as: "wishlist", foreignKey: "userId", onDelete: "CASCADE" });
    User.hasOne(m.Vendor, { as: "vendorProfile", foreignKey: "userId" });
    User.hasMany(m.Store, { as: "stores", foreignKey: "vendorId" });
  };

  User.prototype.toApi = function () {
    const out = withIds(this);
    if (Array.isArray(out.addresses)) out.addresses = this.addresses.map((a) => a.toApi());
    if (Array.isArray(out.wishlist)) out.wishlist = this.wishlist.map((w) => w.toApi());
    return out;
  };

  return User;
};
