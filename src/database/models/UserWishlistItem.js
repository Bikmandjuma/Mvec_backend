const { DataTypes, primaryKey, foreignKey, withIds } = require("./_shared");

// Embedded `wishlist` array of the Mongoose User (saved products), as its own table.
module.exports = (sequelize) => {
  const UserWishlistItem = sequelize.define("UserWishlistItem", {
    id: primaryKey(),
    userId: foreignKey(false),
    productId: foreignKey(false),
    savedPrice: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0, get() { const v = this.getDataValue("savedPrice"); return v === null || v === undefined ? v : Number(v); } },
    savedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  }, { tableName: "user_wishlist_items", timestamps: false });

  UserWishlistItem.associate = (m) => UserWishlistItem.belongsTo(m.User, { foreignKey: "userId" });
  UserWishlistItem.prototype.toApi = function () {
    const { userId, productId, id, _id, ...rest } = withIds(this);
    return { product: productId, ...rest };
  };
  return UserWishlistItem;
};
