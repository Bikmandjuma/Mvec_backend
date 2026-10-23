"use strict";

// Suppliers run stores (warehouses, depots, branches) the way vendors run
// theirs: one primary store, more can be registered, and every wholesale
// product is stocked in one of them (empty = the primary store). Kept apart
// from the retail `stores` table so supplier stores never show in the shop.
module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;
    await queryInterface.createTable("supplier_stores", {
      id: { type: S.CHAR(24), primaryKey: true, allowNull: false },
      supplierId: { type: S.CHAR(24), allowNull: false },
      isPrimary: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      storeName: { type: S.STRING(150), allowNull: false },
      slug: { type: S.STRING(190), allowNull: true, unique: true },
      logo: { type: S.STRING(500), allowNull: true, defaultValue: "" },
      description: { type: S.TEXT, allowNull: true },
      businessCategory: { type: S.STRING(120), allowNull: true, defaultValue: "General" },
      contactEmail: { type: S.STRING(190), allowNull: false },
      contactPhone: { type: S.STRING(30), allowNull: false },
      addressCity: { type: S.STRING(120), allowNull: true, defaultValue: "Kigali" },
      businessAddress: { type: S.STRING(255), allowNull: true, defaultValue: "" },
      status: { type: S.ENUM("ACTIVE", "CLOSED"), allowNull: false, defaultValue: "ACTIVE" },
      createdAt: { type: S.DATE(3), allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP(3)") },
      updatedAt: { type: S.DATE(3), allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP(3)") },
    });
    await queryInterface.addIndex("supplier_stores", ["supplierId", "isPrimary"]);
    await queryInterface.addColumn("wholesale_products", "storeId", { type: S.CHAR(24), allowNull: true });
    await queryInterface.addIndex("wholesale_products", ["storeId"]);
  },
  async down(queryInterface) {
    await queryInterface.removeIndex("wholesale_products", ["storeId"]);
    await queryInterface.removeColumn("wholesale_products", "storeId");
    await queryInterface.dropTable("supplier_stores");
  },
};
