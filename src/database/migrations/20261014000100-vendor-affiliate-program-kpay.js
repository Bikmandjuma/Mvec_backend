"use strict";

/**
 * Seller-controlled affiliate program and K-Pay payments.
 * - vendors: program switch (off by default), seller-paid rate, scope ALL/SELECTED
 * - products: chosen for the program (SELECTED scope)
 * - order_items: seller rate frozen at checkout
 * - settlements / pricing_snapshots: seller-paid part of the commission
 * - ledger: AFFILIATE_COMMISSION entries; payments/webhooks: K-Pay + SPENN;
 *   disbursements: MANUAL channel (refunds an admin does in the provider portal)
 * Only adds columns and widens enums.
 */
const E = {
  entry: [["PAYMENT_ESCROW_LOCK", "ESCROW_RELEASE_VENDOR", "PLATFORM_COMMISSION_DEDUCTION", "COURIER_FEE_PAYOUT", "BUYER_REFUND", "ADMIN_MANUAL_ADJUSTMENT"], ["PAYMENT_ESCROW_LOCK", "ESCROW_RELEASE_VENDOR", "PLATFORM_COMMISSION_DEDUCTION", "COURIER_FEE_PAYOUT", "BUYER_REFUND", "ADMIN_MANUAL_ADJUSTMENT", "AFFILIATE_COMMISSION"]],
  method: [["MOMO", "AIRTEL", "CASH_ON_DELIVERY", "CARD"], ["MOMO", "AIRTEL", "CASH_ON_DELIVERY", "CARD", "SPENN"]],
  gateway: [["PAYPACK", "MOMO", "AIRTEL", "FLUTTERWAVE"], ["PAYPACK", "MOMO", "AIRTEL", "FLUTTERWAVE", "KPAY"]],
  provider: [["MTN", "AIRTEL", "CASH", "CARD"], ["MTN", "AIRTEL", "CASH", "CARD", "SPENN"]],
  logProvider: [["MTN_MOMO", "AIRTEL_MONEY", "PAYPACK", "FLUTTERWAVE"], ["MTN_MOMO", "AIRTEL_MONEY", "PAYPACK", "FLUTTERWAVE", "KPAY"]],
  channel: [["MOMO", "CARD"], ["MOMO", "CARD", "MANUAL"]],
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;
    await queryInterface.addColumn("vendors", "affiliateEnabled", { type: S.BOOLEAN, allowNull: false, defaultValue: false });
    await queryInterface.addColumn("vendors", "affiliateRate", { type: S.DECIMAL(5, 2), allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn("vendors", "affiliateScope", { type: S.ENUM("ALL", "SELECTED"), allowNull: false, defaultValue: "ALL" });
    await queryInterface.addColumn("vendors", "affiliateUpdatedAt", { type: S.DATE(3), allowNull: true });
    await queryInterface.addColumn("products", "affiliateEnabled", { type: S.BOOLEAN, allowNull: false, defaultValue: false });
    await queryInterface.addColumn("order_items", "affiliateVendorRate", { type: S.DOUBLE, allowNull: true });
    await queryInterface.addColumn("settlements", "vendorAffiliateShare", { type: S.DECIMAL(14, 2), allowNull: false, defaultValue: 0 });
    await queryInterface.addColumn("pricing_snapshots", "vendorAffiliateShare", { type: S.DECIMAL(14, 2), allowNull: false, defaultValue: 0 });

    await queryInterface.changeColumn("ledger_entries", "entryType", { type: S.ENUM(...E.entry[1]), allowNull: false });
    await queryInterface.changeColumn("payments", "method", { type: S.ENUM(...E.method[1]), allowNull: false });
    await queryInterface.changeColumn("payments", "gateway", { type: S.ENUM(...E.gateway[1]), allowNull: true });
    await queryInterface.changeColumn("payments", "provider", { type: S.ENUM(...E.provider[1]), allowNull: false });
    await queryInterface.changeColumn("payment_webhook_logs", "provider", { type: S.ENUM(...E.logProvider[1]), allowNull: false });
    await queryInterface.changeColumn("disbursements", "channel", { type: S.ENUM(...E.channel[1]), allowNull: false, defaultValue: "MOMO" });
  },

  async down(queryInterface, Sequelize) {
    const S = Sequelize;
    await queryInterface.changeColumn("disbursements", "channel", { type: S.ENUM(...E.channel[0]), allowNull: false, defaultValue: "MOMO" });
    await queryInterface.changeColumn("payment_webhook_logs", "provider", { type: S.ENUM(...E.logProvider[0]), allowNull: false });
    await queryInterface.changeColumn("payments", "provider", { type: S.ENUM(...E.provider[0]), allowNull: false });
    await queryInterface.changeColumn("payments", "gateway", { type: S.ENUM(...E.gateway[0]), allowNull: true });
    await queryInterface.changeColumn("payments", "method", { type: S.ENUM(...E.method[0]), allowNull: false });
    await queryInterface.changeColumn("ledger_entries", "entryType", { type: S.ENUM(...E.entry[0]), allowNull: false });
    for (const [t, c] of [["pricing_snapshots", "vendorAffiliateShare"], ["settlements", "vendorAffiliateShare"], ["order_items", "affiliateVendorRate"], ["products", "affiliateEnabled"], ["vendors", "affiliateUpdatedAt"], ["vendors", "affiliateScope"], ["vendors", "affiliateRate"], ["vendors", "affiliateEnabled"]]) {
      await queryInterface.removeColumn(t, c);
    }
  },
};
