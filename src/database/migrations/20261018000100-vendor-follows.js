"use strict";

// Buyers following stores, saved on the server so it works on every device
// and the store can show its follower count.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("vendor_follows", {
      userId: { type: Sequelize.CHAR(24), allowNull: false, primaryKey: true, references: { model: "users", key: "id" }, onDelete: "CASCADE", onUpdate: "CASCADE" },
      vendorId: { type: Sequelize.CHAR(24), allowNull: false, primaryKey: true, references: { model: "vendors", key: "id" }, onDelete: "CASCADE", onUpdate: "CASCADE" },
      createdAt: { type: Sequelize.DATE(3), allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP(3)") },
    });
    await queryInterface.addIndex("vendor_follows", ["vendorId"]);
  },
  async down(queryInterface) {
    await queryInterface.dropTable("vendor_follows");
  },
};
