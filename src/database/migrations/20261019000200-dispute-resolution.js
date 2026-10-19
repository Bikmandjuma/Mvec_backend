"use strict";

// Problem reports become a case the buyer, seller and MVEC work through:
// the seller can refund or offer a partial refund, either side can ask MVEC
// to decide, the buyer can withdraw, and every step is on one timeline.
const STATUS_OLD = ["OPEN", "UNDER_REVIEW", "EVIDENCE_SUBMITTED", "RESOLVED_BUYER_REFUNDED", "RESOLVED_VENDOR_RELEASED", "RESOLVED_SPLIT", "REJECTED"];
const STATUS_NEW = [...STATUS_OLD, "WITHDRAWN"];

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn("disputes", "status", { type: Sequelize.ENUM(...STATUS_NEW), allowNull: false, defaultValue: "OPEN" });
    const add = (name, spec) => queryInterface.addColumn("disputes", name, spec);
    await add("respondBy", { type: Sequelize.DATE(3), allowNull: true });
    await add("offerAmount", { type: Sequelize.DECIMAL(14, 2), allowNull: true });
    await add("offerNote", { type: Sequelize.TEXT, allowNull: true });
    await add("offerStatus", { type: Sequelize.ENUM("PENDING", "ACCEPTED", "DECLINED"), allowNull: true });
    await add("offeredAt", { type: Sequelize.DATE(3), allowNull: true });
    await add("escalatedAt", { type: Sequelize.DATE(3), allowNull: true });
    await add("escalationReason", { type: Sequelize.STRING(300), allowNull: true });
    await add("closedAt", { type: Sequelize.DATE(3), allowNull: true });
    await queryInterface.changeColumn("dispute_evidences", "senderRole", { type: Sequelize.ENUM("buyer", "vendor", "super_admin", "system"), allowNull: false });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.changeColumn("dispute_evidences", "senderRole", { type: Sequelize.ENUM("buyer", "vendor", "super_admin"), allowNull: false });
    for (const c of ["respondBy", "offerAmount", "offerNote", "offerStatus", "offeredAt", "escalatedAt", "escalationReason", "closedAt"]) await queryInterface.removeColumn("disputes", c);
    await queryInterface.changeColumn("disputes", "status", { type: Sequelize.ENUM(...STATUS_OLD), allowNull: false, defaultValue: "OPEN" });
  },
};
