"use strict";

/**
 * Card payments (Flutterwave): new payment method/gateway/provider values and
 * card refunds in the disbursement queue. Only widens enums and adds columns.
 */
const E = {
  method: [["MOMO", "AIRTEL", "CASH_ON_DELIVERY"], ["MOMO", "AIRTEL", "CASH_ON_DELIVERY", "CARD"]],
  gateway: [["PAYPACK", "MOMO", "AIRTEL"], ["PAYPACK", "MOMO", "AIRTEL", "FLUTTERWAVE"]],
  provider: [["MTN", "AIRTEL", "CASH"], ["MTN", "AIRTEL", "CASH", "CARD"]],
  logProvider: [["MTN_MOMO", "AIRTEL_MONEY", "PAYPACK"], ["MTN_MOMO", "AIRTEL_MONEY", "PAYPACK", "FLUTTERWAVE"]],
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;
    await queryInterface.changeColumn("payments", "method", { type: S.ENUM(...E.method[1]), allowNull: false });
    await queryInterface.changeColumn("payments", "gateway", { type: S.ENUM(...E.gateway[1]), allowNull: true });
    await queryInterface.changeColumn("payments", "provider", { type: S.ENUM(...E.provider[1]), allowNull: false });
    await queryInterface.changeColumn("payment_webhook_logs", "provider", { type: S.ENUM(...E.logProvider[1]), allowNull: false });

    await queryInterface.addColumn("disbursements", "channel", { type: S.ENUM("MOMO", "CARD"), allowNull: false, defaultValue: "MOMO" });
    await queryInterface.addColumn("disbursements", "cardTransactionId", { type: S.STRING(120), allowNull: true });
    await queryInterface.changeColumn("disbursements", "phone", { type: S.STRING(30), allowNull: true });
  },

  async down(queryInterface, Sequelize) {
    const S = Sequelize;
    await queryInterface.changeColumn("disbursements", "phone", { type: S.STRING(30), allowNull: false });
    await queryInterface.removeColumn("disbursements", "cardTransactionId");
    await queryInterface.removeColumn("disbursements", "channel");
    await queryInterface.changeColumn("payment_webhook_logs", "provider", { type: S.ENUM(...E.logProvider[0]), allowNull: false });
    await queryInterface.changeColumn("payments", "provider", { type: S.ENUM(...E.provider[0]), allowNull: false });
    await queryInterface.changeColumn("payments", "gateway", { type: S.ENUM(...E.gateway[0]), allowNull: true });
    await queryInterface.changeColumn("payments", "method", { type: S.ENUM(...E.method[0]), allowNull: false });
  },
};
