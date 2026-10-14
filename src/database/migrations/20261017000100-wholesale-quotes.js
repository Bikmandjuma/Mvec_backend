"use strict";

/**
 * Wholesale made whole: vendor quote requests and supplier quotes (replacing
 * suppliers asking MVEC to source goods), orders created from quotes, stock
 * reservation, cancellation/dispute details, and commission rules scoped to
 * retail or wholesale.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;
    const id = () => ({ type: S.CHAR(24), primaryKey: true, allowNull: false });
    const ref = (allowNull = true) => ({ type: S.CHAR(24), allowNull });
    const date = (allowNull = true) => ({ type: S.DATE(3), allowNull });
    const timestamps = () => ({
      createdAt: { type: S.DATE(3), allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP(3)") },
      updatedAt: { type: S.DATE(3), allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP(3)") },
    });

    for (const t of ["admin_payouts", "developer_payouts"]) {
      await queryInterface.changeColumn(t, "paymentMethod", { type: S.ENUM("MOMO", "AIRTEL", "BANK"), allowNull: true, defaultValue: "MOMO" });
    }
    await queryInterface.addColumn("commission_rules", "scope", { type: S.ENUM("RETAIL", "WHOLESALE"), allowNull: false, defaultValue: "RETAIL" });

    await queryInterface.addColumn("wholesale_orders", "paidAt", date());
    await queryInterface.addColumn("wholesale_orders", "quoteId", ref());
    await queryInterface.addColumn("wholesale_orders", "category", { type: S.STRING(120), allowNull: true, defaultValue: "" });
    await queryInterface.addColumn("wholesale_orders", "stockReserved", { type: S.BOOLEAN, allowNull: false, defaultValue: false });
    await queryInterface.addColumn("wholesale_orders", "cancelledBy", { type: S.STRING(20), allowNull: true, defaultValue: "" });
    await queryInterface.addColumn("wholesale_orders", "cancelReason", { type: S.STRING(300), allowNull: true, defaultValue: "" });
    await queryInterface.addColumn("wholesale_orders", "disputeReason", { type: S.TEXT, allowNull: true });
    await queryInterface.changeColumn("wholesale_order_items", "productId", ref(true));
    await queryInterface.addColumn("wholesale_order_items", "unit", { type: S.STRING(40), allowNull: true, defaultValue: "piece" });

    await queryInterface.createTable("quote_requests", {
      id: id(),
      reference: { type: S.STRING(40), allowNull: false, unique: true },
      vendorId: ref(false),
      category: { type: S.STRING(120), allowNull: false },
      lines: { type: S.JSON, allowNull: true },
      neededBy: date(false),
      deliverTo: { type: S.STRING(200), allowNull: true, defaultValue: "" },
      note: { type: S.TEXT, allowNull: true },
      status: { type: S.ENUM("OPEN", "AWARDED", "CANCELLED", "EXPIRED"), allowNull: false, defaultValue: "OPEN" },
      acceptedQuoteId: ref(),
      wholesaleOrderId: ref(),
      ...timestamps(),
    });
    for (const cols of [["vendorId"], ["category"], ["status"], ["status", "neededBy"]]) await queryInterface.addIndex("quote_requests", cols);

    await queryInterface.createTable("quotes", {
      id: id(),
      requestId: ref(false),
      supplierId: ref(false),
      lines: { type: S.JSON, allowNull: true },
      totalAmount: { type: S.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      deliveryDays: { type: S.INTEGER, allowNull: false, defaultValue: 1 },
      note: { type: S.TEXT, allowNull: true },
      validUntil: date(),
      status: { type: S.ENUM("SUBMITTED", "ACCEPTED", "DECLINED", "WITHDRAWN"), allowNull: false, defaultValue: "SUBMITTED" },
      ...timestamps(),
    });
    await queryInterface.addIndex("quotes", ["requestId", "supplierId"], { unique: true });
    for (const cols of [["supplierId"], ["status"]]) await queryInterface.addIndex("quotes", cols);
  },

  async down(queryInterface, Sequelize) {
    const S = Sequelize;
    await queryInterface.dropTable("quotes");
    await queryInterface.dropTable("quote_requests");
    await queryInterface.removeColumn("wholesale_order_items", "unit");
    await queryInterface.changeColumn("wholesale_order_items", "productId", { type: S.CHAR(24), allowNull: false });
    for (const c of ["disputeReason", "cancelReason", "cancelledBy", "stockReserved", "category", "quoteId", "paidAt"]) await queryInterface.removeColumn("wholesale_orders", c);
    await queryInterface.removeColumn("commission_rules", "scope");
    for (const t of ["admin_payouts", "developer_payouts"]) {
      await queryInterface.changeColumn(t, "paymentMethod", { type: S.ENUM("MOMO", "AIRTEL"), allowNull: true, defaultValue: "MOMO" });
    }
  },
};
