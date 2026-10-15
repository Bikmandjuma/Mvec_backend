"use strict";

/** Staff: marketing/finance roles, marketing permission, last activity, and the staff activity log. */
const ROLES = ["STORE_MANAGER", "ORDER_MANAGER", "CATALOG_MANAGER", "MARKETING_MANAGER", "FINANCE_MANAGER"];
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn("staff", "role", { type: Sequelize.ENUM(...ROLES), allowNull: false, defaultValue: "ORDER_MANAGER" });
    await queryInterface.addColumn("staff", "canManageMarketing", { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false });
    await queryInterface.addColumn("staff", "lastActiveAt", { type: Sequelize.DATE(3), allowNull: true });
    await queryInterface.createTable("staff_activities", {
      id: { type: Sequelize.CHAR(24), primaryKey: true, allowNull: false },
      vendorId: { type: Sequelize.CHAR(24), allowNull: false, references: { model: "users", key: "id" }, onDelete: "CASCADE", onUpdate: "CASCADE" },
      userId: { type: Sequelize.CHAR(24), allowNull: false },
      staffId: { type: Sequelize.CHAR(24), allowNull: true },
      action: { type: Sequelize.STRING(150), allowNull: false },
      method: { type: Sequelize.STRING(10), allowNull: false },
      path: { type: Sequelize.STRING(300), allowNull: false },
      statusCode: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 200 },
      createdAt: { type: Sequelize.DATE(3), allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP(3)") },
      updatedAt: { type: Sequelize.DATE(3), allowNull: false, defaultValue: Sequelize.literal("CURRENT_TIMESTAMP(3)") },
    });
    await queryInterface.addIndex("staff_activities", ["vendorId", "createdAt"]);
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable("staff_activities");
    await queryInterface.removeColumn("staff", "lastActiveAt");
    await queryInterface.removeColumn("staff", "canManageMarketing");
    await queryInterface.sequelize.query("UPDATE staff SET role = 'STORE_MANAGER' WHERE role IN ('MARKETING_MANAGER', 'FINANCE_MANAGER')");
    await queryInterface.changeColumn("staff", "role", { type: Sequelize.ENUM(...ROLES.slice(0, 3)), allowNull: false, defaultValue: "ORDER_MANAGER" });
  },
};
