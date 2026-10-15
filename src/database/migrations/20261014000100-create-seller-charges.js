"use strict";

/** seller_charges: money MVEC takes from a seller's balance (subscriptions, ads, adjustments). */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("seller_charges", {
      id: { type: Sequelize.CHAR(24), primaryKey: true, allowNull: false },
      vendorId: { type: Sequelize.CHAR(24), allowNull: false, references: { model: "users", key: "id" }, onDelete: "CASCADE", onUpdate: "CASCADE" },
      type: { type: Sequelize.ENUM("SUBSCRIPTION", "ADVERTISING", "ADJUSTMENT"), allowNull: false },
      amount: { type: Sequelize.DECIMAL(14, 2), allowNull: false },
      reference: { type: Sequelize.STRING(120), allowNull: true, defaultValue: "" },
      description: { type: Sequelize.STRING(300), allowNull: true, defaultValue: "" },
      status: { type: Sequelize.ENUM("CHARGED", "REFUNDED"), allowNull: false, defaultValue: "CHARGED" },
      createdAt: { type: Sequelize.DATE(3), allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP(3)") },
      updatedAt: { type: Sequelize.DATE(3), allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP(3)") },
    });
    await queryInterface.addIndex("seller_charges", ["vendorId", "createdAt"]);
  },
  async down(queryInterface) {
    await queryInterface.dropTable("seller_charges");
  },
};
