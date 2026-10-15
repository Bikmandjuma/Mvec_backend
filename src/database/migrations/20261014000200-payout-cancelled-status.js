"use strict";

/** Sellers can cancel a payout request that hasn't been processed yet. */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn("payouts", "status", {
      type: Sequelize.ENUM("PENDING", "PROCESSING", "PAID", "REJECTED", "FAILED", "CANCELLED"),
      allowNull: false,
      defaultValue: "PENDING",
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query("UPDATE payouts SET status = 'REJECTED' WHERE status = 'CANCELLED'");
    await queryInterface.changeColumn("payouts", "status", {
      type: Sequelize.ENUM("PENDING", "PROCESSING", "PAID", "REJECTED", "FAILED"),
      allowNull: false,
      defaultValue: "PENDING",
    });
  },
};
