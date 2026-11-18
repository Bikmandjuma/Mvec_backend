"use strict";

// Early dispatch, as in KitchenLink: a rider parcel is offered when the buyer
// pays, and `readyAt` records when the seller marked it ready. Parcels made
// before this were only ever created once ready, so they count as ready.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("deliveries", "readyAt", { type: Sequelize.DATE(3), allowNull: true });
    await queryInterface.sequelize.query("UPDATE deliveries SET readyAt = createdAt WHERE readyAt IS NULL");
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("deliveries", "readyAt");
  },
};
