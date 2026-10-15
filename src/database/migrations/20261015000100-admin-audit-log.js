"use strict";

/**
 * Audit log of administrator actions (written by middleware/adminAudit.js),
 * and the reason shown to a seller or supplier when their profile is rejected.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;
    await queryInterface.createTable("audit_logs", {
      id: { type: S.CHAR(24), primaryKey: true, allowNull: false },
      actorId: { type: S.CHAR(24), allowNull: true },
      actorName: { type: S.STRING(150), allowNull: true, defaultValue: "" },
      action: { type: S.STRING(200), allowNull: false },
      method: { type: S.STRING(10), allowNull: true, defaultValue: "" },
      path: { type: S.STRING(300), allowNull: true, defaultValue: "" },
      targetType: { type: S.STRING(60), allowNull: true, defaultValue: "" },
      targetId: { type: S.STRING(60), allowNull: true, defaultValue: "" },
      statusCode: { type: S.INTEGER, allowNull: true, defaultValue: 200 },
      detail: { type: S.JSON, allowNull: true },
      ip: { type: S.STRING(60), allowNull: true, defaultValue: "" },
      createdAt: { type: S.DATE(3), allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP(3)") },
    });
    await queryInterface.addIndex("audit_logs", ["actorId"]);
    await queryInterface.addIndex("audit_logs", ["createdAt"]);
    await queryInterface.addIndex("audit_logs", ["targetType", "targetId"]);
    await queryInterface.addColumn("vendors", "verificationNote", { type: S.STRING(500), allowNull: true, defaultValue: "" });
    await queryInterface.addColumn("suppliers", "verificationNote", { type: S.STRING(500), allowNull: true, defaultValue: "" });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("suppliers", "verificationNote");
    await queryInterface.removeColumn("vendors", "verificationNote");
    await queryInterface.dropTable("audit_logs");
  },
};
