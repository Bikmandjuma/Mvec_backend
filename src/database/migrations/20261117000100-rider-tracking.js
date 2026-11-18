"use strict";

// Live tracking, as in KitchenLink: a rider's fix carries heading, speed and
// accuracy, and a parcel not collected in time is flagged, then re-offered.
module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;
    await queryInterface.addColumn("riders", "heading", { type: S.DECIMAL(5, 1), allowNull: true });
    await queryInterface.addColumn("riders", "speedMps", { type: S.DECIMAL(6, 2), allowNull: true });
    await queryInterface.addColumn("riders", "accuracyM", { type: S.DECIMAL(7, 1), allowNull: true });
    await queryInterface.addColumn("deliveries", "pickupWarnedAt", { type: S.DATE(3), allowNull: true });
    await queryInterface.addColumn("deliveries", "lateAt", { type: S.DATE(3), allowNull: true });
  },

  async down(queryInterface) {
    for (const column of ["heading", "speedMps", "accuracyM"]) await queryInterface.removeColumn("riders", column);
    for (const column of ["pickupWarnedAt", "lateAt"]) await queryInterface.removeColumn("deliveries", column);
  },
};
