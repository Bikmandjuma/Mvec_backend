"use strict";

/** Paid buyer Premium: payments record what they buy; subscriptions remember the payment that activated them. */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("payments", "purpose", { type: Sequelize.STRING(30), allowNull: true });
    for (const table of ["subscriptions", "buyer_subscriptions"]) {
      await queryInterface.addColumn(table, "lastPaymentId", { type: Sequelize.STRING(24), allowNull: true });
    }
  },
  async down(queryInterface) {
    for (const table of ["subscriptions", "buyer_subscriptions"]) await queryInterface.removeColumn(table, "lastPaymentId");
    await queryInterface.removeColumn("payments", "purpose");
  },
};
