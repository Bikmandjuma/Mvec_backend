"use strict";

// Wholesale purchases land in the vendor's store: an order remembers which
// store receives the goods and when they were added to its inventory, and a
// store product remembers the supplier product it was bought as, so the next
// purchase restocks it instead of listing it twice. Suppliers get a low-stock
// threshold like vendors.
module.exports = {
  async up(queryInterface, Sequelize) {
    const ref = { type: Sequelize.CHAR(24), allowNull: true };
    await queryInterface.addColumn("wholesale_orders", "storeId", ref);
    await queryInterface.addColumn("wholesale_orders", "stockedAt", { type: Sequelize.DATE(3), allowNull: true });
    await queryInterface.addColumn("products", "wholesaleProductId", ref);
    await queryInterface.addIndex("products", ["vendorId", "wholesaleProductId"]);
    await queryInterface.addColumn("wholesale_products", "lowStockThreshold", { type: Sequelize.INTEGER, allowNull: false, defaultValue: 10 });
  },
  async down(queryInterface) {
    await queryInterface.removeColumn("wholesale_products", "lowStockThreshold");
    await queryInterface.removeIndex("products", ["vendorId", "wholesaleProductId"]);
    await queryInterface.removeColumn("products", "wholesaleProductId");
    await queryInterface.removeColumn("wholesale_orders", "stockedAt");
    await queryInterface.removeColumn("wholesale_orders", "storeId");
  },
};
