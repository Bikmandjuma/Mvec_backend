"use strict";

/** Profile: photo, preferences and "sign out everywhere" for every account. */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("users", "avatarUrl", { type: Sequelize.STRING(500), allowNull: true, defaultValue: "" });
    await queryInterface.addColumn("users", "preferences", { type: Sequelize.JSON, allowNull: true });
    await queryInterface.addColumn("users", "tokensValidAfter", { type: Sequelize.DATE(3), allowNull: true });
  },
  async down(queryInterface) {
    for (const c of ["avatarUrl", "preferences", "tokensValidAfter"]) await queryInterface.removeColumn("users", c);
  },
};
