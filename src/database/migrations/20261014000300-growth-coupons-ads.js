"use strict";

/** Growth: coupons redeemed on orders (seller-paid discount) and pay-per-click ad budgets. */
module.exports = {
  async up(queryInterface, Sequelize) {
    const add = (table, column, spec) => queryInterface.addColumn(table, column, spec);
    await add("orders", "couponCode", { type: Sequelize.STRING(60), allowNull: true });
    await add("orders", "couponPromotionId", { type: Sequelize.CHAR(24), allowNull: true });
    await add("orders", "couponVendorId", { type: Sequelize.CHAR(24), allowNull: true });
    await add("orders", "couponType", { type: Sequelize.STRING(20), allowNull: true });
    await add("orders", "discountAmount", { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 });
    await queryInterface.addIndex("orders", ["couponPromotionId"]);
    await add("order_items", "discount", { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 });
    await add("order_parcels", "originalFee", { type: Sequelize.DECIMAL(14, 2), allowNull: true });
    await add("advertisements", "spent", { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 });
    await add("advertisements", "refunded", { type: Sequelize.DECIMAL(14, 2), allowNull: false, defaultValue: 0 });
    await add("advertisements", "rejectionReason", { type: Sequelize.STRING(500), allowNull: true, defaultValue: "" });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex("orders", ["couponPromotionId"]);
    for (const c of ["couponCode", "couponPromotionId", "couponVendorId", "couponType", "discountAmount"]) await queryInterface.removeColumn("orders", c);
    await queryInterface.removeColumn("order_items", "discount");
    await queryInterface.removeColumn("order_parcels", "originalFee");
    for (const c of ["spent", "refunded", "rejectionReason"]) await queryInterface.removeColumn("advertisements", c);
  },
};
