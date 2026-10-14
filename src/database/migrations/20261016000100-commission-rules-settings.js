"use strict";

/**
 * Commission rules become live: platform settings (developer/affiliate share
 * of the commission, who pays provider fees) and, on each settlement, the
 * commission % that was applied and who bore the provider fee.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;
    await queryInterface.createTable("platform_settings", {
      id: { type: S.CHAR(24), primaryKey: true, allowNull: false },
      settingKey: { type: S.STRING(80), allowNull: false, unique: true },
      value: { type: S.JSON, allowNull: true },
      updatedById: { type: S.CHAR(24), allowNull: true },
      createdAt: { type: S.DATE(3), allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP(3)") },
      updatedAt: { type: S.DATE(3), allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP(3)") },
    });
    await queryInterface.addColumn("settlements", "commissionRate", { type: S.DOUBLE, allowNull: true });
    await queryInterface.addColumn("settlements", "gatewayFeePayer", { type: S.ENUM("MVEC", "SELLER"), allowNull: false, defaultValue: "MVEC" });
    await queryInterface.addIndex("commission_rules", ["isActive", "ruleType"]);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("commission_rules", ["isActive", "ruleType"]);
    await queryInterface.removeColumn("settlements", "gatewayFeePayer");
    await queryInterface.removeColumn("settlements", "commissionRate");
    await queryInterface.dropTable("platform_settings");
  },
};
