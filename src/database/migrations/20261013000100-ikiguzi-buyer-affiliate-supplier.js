"use strict";

/**
 * Brings the MySQL schema level with the Ikiguzi features merged after the
 * first MySQL release: buyer delivery details and courier hand-over, refunds
 * and withdrawals (disbursements), affiliate attribution and reversals,
 * wishlists, seller/supplier onboarding, supplier teams, reviews and supply
 * requests. Mirrors src/database/spec and src/database/models.
 */
const ENUMS = {
  roleOld: ["buyer", "vendor", "supplier", "affiliate", "super_admin", "developer"],
  roleNew: ["buyer", "vendor", "supplier", "affiliate", "super_admin", "developer", "delivery"],
  paymentStatusOld: ["PENDING", "CONFIRMED", "PAID", "FAILED", "REFUNDED"],
  paymentStatusNew: ["PENDING", "CONFIRMED", "PAID", "FAILED", "REFUNDED", "DISPUTED"],
  payoutMethodOld: ["MOMO", "AIRTEL"],
  payoutMethodNew: ["MOMO", "AIRTEL", "BANK"],
  conversionStatusOld: ["PENDING", "APPROVED", "PAID", "REJECTED"],
  conversionStatusNew: ["PENDING", "APPROVED", "PAID", "REJECTED", "REVERSED"],
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;
    const id = () => ({ type: S.CHAR(24), primaryKey: true, allowNull: false });
    const ref = (allowNull = true) => ({ type: S.CHAR(24), allowNull });
    const date = (allowNull = true, extra = {}) => ({ type: S.DATE(3), allowNull, ...extra });
    const now = () => S.literal("CURRENT_TIMESTAMP(3)");
    const timestamps = () => ({ createdAt: date(false, { defaultValue: now() }), updatedAt: date(false, { defaultValue: now() }) });
    const add = (table, columns) => Promise.all(Object.entries(columns).map(([name, def]) => queryInterface.addColumn(table, name, def)));
    const cascade = (model) => ({ references: { model, key: "id" }, onDelete: "CASCADE", onUpdate: "CASCADE" });

    // ── users: onboarding profile, password-reset codes, delivery role ──────
    await queryInterface.changeColumn("users", "role", { type: S.ENUM(...ENUMS.roleNew), allowNull: false, defaultValue: "buyer" });
    await add("users", {
      businessName: { type: S.STRING(150), allowNull: true, defaultValue: "" },
      description: { type: S.TEXT, allowNull: true },
      logoUrl: { type: S.STRING(500), allowNull: true, defaultValue: "" },
      category: { type: S.STRING(120), allowNull: true, defaultValue: "" },
      location: { type: S.JSON, allowNull: true },
      isOnboarded: { type: S.BOOLEAN, allowNull: true },
      verificationStatus: { type: S.ENUM("UNVERIFIED", "PENDING", "VERIFIED", "REJECTED"), allowNull: true },
      avatarUrl: { type: S.STRING(500), allowNull: true, defaultValue: "" },
      resetPasswordCode: { type: S.STRING(255), allowNull: true },
      resetPasswordCodeExpires: date(),
      resetPasswordAttempts: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      isSupplierStaff: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
    });
    // Existing accounts: buyers and staff are ready; sellers keep their status.
    await queryInterface.sequelize.query("UPDATE users SET isOnboarded = (role NOT IN ('vendor','supplier')), verificationStatus = IF(role IN ('vendor','supplier'), 'UNVERIFIED', 'VERIFIED') WHERE isOnboarded IS NULL");
    await queryInterface.sequelize.query("UPDATE users u JOIN vendors v ON v.userId = u.id SET u.isOnboarded = TRUE, u.verificationStatus = v.verificationStatus WHERE u.role = 'vendor'");

    await add("user_addresses", { sector: { type: S.STRING(120), allowNull: true } });

    await queryInterface.createTable("user_wishlist_items", {
      id: id(),
      userId: { ...ref(false), ...cascade("users") },
      productId: { ...ref(false), ...cascade("products") },
      savedPrice: { type: S.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      savedAt: date(false, { defaultValue: now() }),
    });
    await queryInterface.addIndex("user_wishlist_items", ["userId", "productId"], { unique: true });

    // ── team members invited by email (no account or store yet) ─────────────
    await queryInterface.changeColumn("staff", "storeId", ref(true));
    await queryInterface.changeColumn("staff", "userId", ref(true));
    await add("staff", {
      email: { type: S.STRING(190), allowNull: true, defaultValue: "" },
      invitationTokenHash: { type: S.STRING(128), allowNull: true },
      invitationExpiresAt: date(),
    });
    await queryInterface.addIndex("staff", ["email"]);

    await add("vendors", { category: { type: S.STRING(120), allowNull: true, defaultValue: "" } });
    await add("suppliers", { category: { type: S.STRING(120), allowNull: true, defaultValue: "" } });

    // ── orders: recipient, courier hand-over, disputes ──────────────────────
    await queryInterface.changeColumn("orders", "shippingAddressState", { type: S.STRING(120), allowNull: true });
    await queryInterface.changeColumn("orders", "paymentStatus", { type: S.ENUM(...ENUMS.paymentStatusNew), allowNull: false, defaultValue: "PENDING" });
    await add("orders", {
      recipientName: { type: S.STRING(150), allowNull: true },
      recipientPhone: { type: S.STRING(30), allowNull: true },
      recipientEmail: { type: S.STRING(190), allowNull: true },
      deliveryMethod: { type: S.ENUM("standard", "express", "pickup"), allowNull: true, defaultValue: "standard" },
      paidAt: date(),
      deliveryOtpAttempts: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      courierId: ref(true),
      deliveredVendors: { type: S.JSON, allowNull: true },
      shippedAt: date(),
      paymentReminderSentAt: date(),
    });
    await queryInterface.addIndex("orders", ["courierId"]);
    await add("order_items", {
      affiliateUserId: ref(true),
      affiliateLinkId: ref(true),
      affiliateCode: { type: S.STRING(60), allowNull: true },
      affiliateClickedAt: date(),
    });

    await add("settlements", { orderItemId: ref(true) });
    await queryInterface.addIndex("settlements", ["orderId", "orderItemId"], { unique: true });

    await queryInterface.changeColumn("payouts", "payoutMethod", { type: S.ENUM(...ENUMS.payoutMethodNew), allowNull: true, defaultValue: "MOMO" });
    await add("payouts", { note: { type: S.STRING(500), allowNull: true, defaultValue: "" } });

    await queryInterface.createTable("disbursements", {
      id: id(),
      kind: { type: S.ENUM("REFUND", "AFFILIATE_PAYOUT", "VENDOR_PAYOUT"), allowNull: false },
      recipientId: ref(false),
      phone: { type: S.STRING(30), allowNull: false },
      amount: { type: S.DECIMAL(14, 2), allowNull: false },
      orderId: ref(true),
      affiliatePayoutId: ref(true),
      vendorPayoutId: ref(true),
      idempotencyKey: { type: S.STRING(120), allowNull: false, unique: true },
      status: { type: S.ENUM("QUEUED", "SENT", "SUCCESS", "FAILED"), allowNull: false, defaultValue: "QUEUED" },
      gatewayReference: { type: S.STRING(120), allowNull: true },
      attempts: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      lastError: { type: S.STRING(300), allowNull: true, defaultValue: "" },
      nextAttemptAt: date(true, { defaultValue: now() }),
      completedAt: date(),
      ...timestamps(),
    });
    for (const cols of [["kind"], ["orderId"], ["status", "nextAttemptAt"], ["gatewayReference"]]) await queryInterface.addIndex("disbursements", cols);

    await add("notifications", { link: { type: S.STRING(500), allowNull: true, defaultValue: "" } });

    // ── affiliates: per-product attribution, link termination, reversals ────
    await add("affiliate_clicks", { productId: ref(true), visitorId: { type: S.STRING(120), allowNull: true, defaultValue: "" } });
    await queryInterface.addIndex("affiliate_clicks", ["productId"]);
    await queryInterface.addIndex("affiliate_clicks", ["visitorId"]);
    await add("affiliate_links", {
      status: { type: S.ENUM("ACTIVE", "TERMINATED"), allowNull: false, defaultValue: "ACTIVE" },
      terminatedAt: date(),
    });
    await queryInterface.addIndex("affiliate_links", ["status"]);

    await queryInterface.createTable("affiliate_attributions", {
      id: id(),
      visitorId: { type: S.STRING(120), allowNull: false },
      productId: ref(false),
      linkId: ref(false),
      affiliateUserId: ref(false),
      affiliateCode: { type: S.STRING(60), allowNull: false },
      clickedAt: date(false),
      ...timestamps(),
    });
    await queryInterface.addIndex("affiliate_attributions", ["visitorId", "productId"], { unique: true });
    await queryInterface.addIndex("affiliate_attributions", ["affiliateUserId"]);

    await queryInterface.changeColumn("conversion_audits", "status", { type: S.ENUM(...ENUMS.conversionStatusNew), allowNull: false, defaultValue: "PENDING" });
    await add("conversion_audits", {
      orderItemId: ref(true),
      settlementId: ref(true),
      buyerId: ref(true),
      quantity: { type: S.INTEGER, allowNull: false, defaultValue: 1 },
      clickedAt: date(),
      reversedAmount: { type: S.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      unrecoveredAmount: { type: S.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      approvedAt: date(),
    });
    await queryInterface.addIndex("conversion_audits", ["orderId", "orderItemId"], { unique: true });
    await queryInterface.createTable("conversion_reversals", {
      id: id(),
      conversionAuditId: { ...ref(false), ...cascade("conversion_audits") },
      position: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      key: { type: S.STRING(120), allowNull: false },
      amount: { type: S.DECIMAL(14, 2), allowNull: false },
      reason: { type: S.STRING(300), allowNull: true, defaultValue: "" },
      at: date(true, { defaultValue: now() }),
    });
    await queryInterface.addIndex("conversion_reversals", ["conversionAuditId", "position"]);

    // ── suppliers: reviews, supply requests, team ───────────────────────────
    await queryInterface.createTable("supplier_reviews", {
      id: id(),
      supplierId: ref(false),
      vendorId: ref(false),
      wholesaleOrderId: ref(false),
      rating: { type: S.DOUBLE, allowNull: false },
      comment: { type: S.TEXT, allowNull: true },
      reply: { type: S.TEXT, allowNull: true },
      ...timestamps(),
    });
    await queryInterface.addIndex("supplier_reviews", ["supplierId", "vendorId", "wholesaleOrderId"], { unique: true });
    await queryInterface.addIndex("supplier_reviews", ["supplierId", "createdAt"]);

    await queryInterface.createTable("supplier_supply_requests", {
      id: id(),
      supplierId: ref(false),
      reference: { type: S.STRING(60), allowNull: false, unique: true },
      neededBy: date(false),
      note: { type: S.TEXT, allowNull: true },
      status: { type: S.ENUM("SUBMITTED", "UNDER_REVIEW", "APPROVED", "SOURCING", "IN_TRANSIT", "RECEIVED", "REJECTED", "CANCELLED"), allowNull: false, defaultValue: "SUBMITTED" },
      decision: { type: S.TEXT, allowNull: true },
      ...timestamps(),
    });
    await queryInterface.addIndex("supplier_supply_requests", ["supplierId", "createdAt"]);
    await queryInterface.addIndex("supplier_supply_requests", ["status"]);
    await queryInterface.createTable("supplier_supply_request_lines", {
      id: id(),
      supplyRequestId: { ...ref(false), ...cascade("supplier_supply_requests") },
      position: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      product: { type: S.STRING(200), allowNull: false },
      category: { type: S.STRING(120), allowNull: true, defaultValue: "General" },
      units: { type: S.DOUBLE, allowNull: false },
      unit: { type: S.STRING(40), allowNull: false },
      unitPrice: { type: S.DECIMAL(14, 2), allowNull: false },
      note: { type: S.STRING(500), allowNull: true, defaultValue: "" },
    });
    await queryInterface.addIndex("supplier_supply_request_lines", ["supplyRequestId", "position"]);
    await queryInterface.createTable("supplier_supply_request_events", {
      id: id(),
      supplyRequestId: { ...ref(false), ...cascade("supplier_supply_requests") },
      position: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      at: date(true, { defaultValue: now() }),
      title: { type: S.STRING(200), allowNull: false },
      detail: { type: S.TEXT, allowNull: true },
    });
    await queryInterface.addIndex("supplier_supply_request_events", ["supplyRequestId", "position"]);

    await queryInterface.createTable("supplier_team_members", {
      id: id(),
      supplierId: ref(false),
      userId: ref(true),
      fullName: { type: S.STRING(150), allowNull: false },
      phone: { type: S.STRING(30), allowNull: false },
      email: { type: S.STRING(190), allowNull: true, defaultValue: "" },
      role: { type: S.ENUM("OPERATIONS", "WAREHOUSE", "FULFILMENT", "FINANCE", "VIEWER"), allowNull: false, defaultValue: "VIEWER" },
      status: { type: S.ENUM("ACTIVE", "INVITED", "SUSPENDED"), allowNull: false, defaultValue: "ACTIVE" },
      note: { type: S.STRING(500), allowNull: true, defaultValue: "" },
      ...timestamps(),
    });
    await queryInterface.addIndex("supplier_team_members", ["supplierId", "createdAt"]);
    await queryInterface.addIndex("supplier_team_members", ["userId"]);
  },

  async down(queryInterface, Sequelize) {
    const S = Sequelize;
    const drop = (table, columns) => Promise.all(columns.map((c) => queryInterface.removeColumn(table, c)));
    for (const t of ["supplier_team_members", "supplier_supply_request_events", "supplier_supply_request_lines", "supplier_supply_requests", "supplier_reviews", "conversion_reversals", "affiliate_attributions", "disbursements", "user_wishlist_items"]) {
      await queryInterface.dropTable(t);
    }
    await queryInterface.removeIndex("conversion_audits", ["orderId", "orderItemId"]);
    await drop("conversion_audits", ["orderItemId", "settlementId", "buyerId", "quantity", "clickedAt", "reversedAmount", "unrecoveredAmount", "approvedAt"]);
    await queryInterface.changeColumn("conversion_audits", "status", { type: S.ENUM(...ENUMS.conversionStatusOld), allowNull: false, defaultValue: "PENDING" });
    await drop("affiliate_links", ["status", "terminatedAt"]);
    await drop("affiliate_clicks", ["productId", "visitorId"]);
    await drop("notifications", ["link"]);
    await drop("payouts", ["note"]);
    await queryInterface.changeColumn("payouts", "payoutMethod", { type: S.ENUM(...ENUMS.payoutMethodOld), allowNull: true, defaultValue: "MOMO" });
    await queryInterface.removeIndex("settlements", ["orderId", "orderItemId"]);
    await drop("settlements", ["orderItemId"]);
    await drop("order_items", ["affiliateUserId", "affiliateLinkId", "affiliateCode", "affiliateClickedAt"]);
    await drop("orders", ["recipientName", "recipientPhone", "recipientEmail", "deliveryMethod", "paidAt", "deliveryOtpAttempts", "courierId", "deliveredVendors", "shippedAt", "paymentReminderSentAt"]);
    await queryInterface.changeColumn("orders", "paymentStatus", { type: S.ENUM(...ENUMS.paymentStatusOld), allowNull: false, defaultValue: "PENDING" });
    await drop("suppliers", ["category"]);
    await drop("vendors", ["category"]);
    await queryInterface.removeIndex("staff", ["email"]);
    await drop("staff", ["email", "invitationTokenHash", "invitationExpiresAt"]);
    await drop("user_addresses", ["sector"]);
    await drop("users", ["businessName", "description", "logoUrl", "category", "location", "isOnboarded", "verificationStatus", "avatarUrl", "resetPasswordCode", "resetPasswordCodeExpires", "resetPasswordAttempts", "isSupplierStaff"]);
    await queryInterface.changeColumn("users", "role", { type: S.ENUM(...ENUMS.roleOld), allowNull: false, defaultValue: "buyer" });
  },
};
