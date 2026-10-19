"use strict";

// Buyers who checked out without creating an account. They proved their
// phone with a one-time code; isGuest switches on the guest order limits and
// is cleared once they set a password.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("users", "isGuest", { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn("users", "isGuest");
  },
};
