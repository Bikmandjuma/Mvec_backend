"use strict";

// A supplier can publish a wholesale product to the marketplace: buyers then
// see and buy it as a normal product sold by the supplier. This links the
// wholesale product to that marketplace listing.
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("wholesale_products", "retailProductId", { type: Sequelize.CHAR(24), allowNull: true });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn("wholesale_products", "retailProductId");
  },
};
