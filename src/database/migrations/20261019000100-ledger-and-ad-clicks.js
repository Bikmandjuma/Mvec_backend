"use strict";

// 1. Ledger: every movement is now money going from one named account to
//    another (buyer payments in, MVEC holding, seller balances, MVEC revenue,
//    ad budgets, money paid out), so balances always add up.
// 2. Ad clicks are remembered in the database (not in server memory), so a
//    restart or a forged header can't be used to bill the same click again.
const ACCOUNT = {
  old: ["ESCROW_HOLDING", "PLATFORM_REVENUE", "VENDOR_PAYABLE", "SUPPLIER_PAYABLE", "COURIER_PAYABLE", "BUYER_REFUND_HOLD", "DEVELOPER_REVENUE", "ADMIN_REVENUE", "AFFILIATE_COMMISSION", "GATEWAY_FEES"],
  add: ["BUYER_PAYMENTS", "PAID_OUT", "AD_BUDGETS"],
};
const ENTRY = {
  old: ["PAYMENT_ESCROW_LOCK", "ESCROW_RELEASE_VENDOR", "PLATFORM_COMMISSION_DEDUCTION", "COURIER_FEE_PAYOUT", "BUYER_REFUND", "ADMIN_MANUAL_ADJUSTMENT", "AFFILIATE_COMMISSION"],
  add: ["PAYMENT_RECEIVED", "PAYOUT_SENT", "AD_BUDGET_RESERVED", "AD_BUDGET_RETURNED", "AD_CLICK_REVENUE", "SUBSCRIPTION_FEE", "GATEWAY_FEE"],
};

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn("ledger_accounts", "accountType", { type: Sequelize.ENUM(...ACCOUNT.old, ...ACCOUNT.add), allowNull: false });
    await queryInterface.changeColumn("ledger_entries", "entryType", { type: Sequelize.ENUM(...ENTRY.old, ...ENTRY.add), allowNull: false });
    await queryInterface.createTable("ad_clicks", {
      advertisementId: { type: Sequelize.CHAR(24), allowNull: false, primaryKey: true },
      visitorKey: { type: Sequelize.STRING(80), allowNull: false, primaryKey: true },
      lastClickAt: { type: Sequelize.DATE(3), allowNull: false },
      paidClicks: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable("ad_clicks");
    await queryInterface.changeColumn("ledger_entries", "entryType", { type: Sequelize.ENUM(...ENTRY.old), allowNull: false });
    await queryInterface.changeColumn("ledger_accounts", "accountType", { type: Sequelize.ENUM(...ACCOUNT.old), allowNull: false });
  },
};
