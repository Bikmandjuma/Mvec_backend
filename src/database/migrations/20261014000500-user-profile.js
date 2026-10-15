"use strict";

/**
 * Profile: photo, preferences and "sign out everywhere" for every account.
 * avatarUrl is also added by 20261013000100-ikiguzi-buyer-affiliate-supplier,
 * so each column is only added when it is missing.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const existing = await queryInterface.describeTable("users");
    const columns = {
      avatarUrl: { type: Sequelize.STRING(500), allowNull: true, defaultValue: "" },
      preferences: { type: Sequelize.JSON, allowNull: true },
      tokensValidAfter: { type: Sequelize.DATE(3), allowNull: true },
    };
    for (const [name, def] of Object.entries(columns)) {
      if (!existing[name]) await queryInterface.addColumn("users", name, def);
    }
  },
  async down(queryInterface) {
    // avatarUrl belongs to the earlier migration and is left in place.
    for (const c of ["preferences", "tokensValidAfter"]) await queryInterface.removeColumn("users", c);
  },
};
