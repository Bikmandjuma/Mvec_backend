"use strict";

// Five marketplace features at once:
//   variants (sizes/colours with their own stock), returns after delivery,
//   seller documents for verification, flash deals, back-in-stock and
//   price-drop alerts, and the devices that receive push notifications.
module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;
    const id = { type: S.CHAR(24), primaryKey: true, allowNull: false };
    const ref = (allowNull = true) => ({ type: S.CHAR(24), allowNull });
    const now = { type: S.DATE, allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP") };
    const stamps = { createdAt: now, updatedAt: now };

    await queryInterface.createTable("product_variants", {
      id,
      productId: { ...ref(false), references: { model: "products", key: "id" }, onDelete: "CASCADE" },
      label: { type: S.STRING(120), allowNull: false },
      options: { type: S.JSON, allowNull: true },
      sku: { type: S.STRING(80), allowNull: true },
      price: { type: S.DECIMAL(14, 2), allowNull: true },
      stockQuantity: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      image: { type: S.STRING(1000), allowNull: true },
      position: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      ...stamps,
    });
    await queryInterface.addIndex("product_variants", ["productId"]);
    await queryInterface.addColumn("cart_items", "variantId", ref());
    await queryInterface.addColumn("order_items", "variantId", ref());
    await queryInterface.addColumn("order_items", "variantLabel", { type: S.STRING(120), allowNull: true });
    await queryInterface.addColumn("order_items", "deal", { type: S.BOOLEAN, allowNull: false, defaultValue: false });

    await queryInterface.addColumn("products", "dealPrice", { type: S.DECIMAL(14, 2), allowNull: true });
    await queryInterface.addColumn("products", "dealStartsAt", { type: S.DATE, allowNull: true });
    await queryInterface.addColumn("products", "dealEndsAt", { type: S.DATE, allowNull: true });
    await queryInterface.addColumn("products", "dealQuantity", { type: S.INTEGER, allowNull: true });
    await queryInterface.addColumn("products", "dealSold", { type: S.INTEGER, allowNull: false, defaultValue: 0 });

    await queryInterface.addColumn("vendors", "documents", { type: S.JSON, allowNull: true });
    await queryInterface.addColumn("suppliers", "documents", { type: S.JSON, allowNull: true });

    await queryInterface.createTable("return_requests", {
      id,
      returnNumber: { type: S.STRING(40), allowNull: false, unique: true },
      orderId: ref(false),
      buyerId: ref(false),
      vendorId: ref(false),
      items: { type: S.JSON, allowNull: true },
      reason: { type: S.ENUM("DAMAGED", "WRONG_ITEM", "NOT_AS_DESCRIBED", "MISSING_PARTS", "DOES_NOT_FIT", "CHANGED_MIND", "OTHER"), allowNull: false },
      description: { type: S.TEXT, allowNull: true },
      photos: { type: S.JSON, allowNull: true },
      status: { type: S.ENUM("REQUESTED", "APPROVED", "REJECTED", "ESCALATED", "RECEIVED", "REFUNDED", "CANCELLED"), allowNull: false, defaultValue: "REQUESTED" },
      refundAmount: { type: S.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      sellerNote: { type: S.TEXT, allowNull: true },
      adminNote: { type: S.TEXT, allowNull: true },
      respondBy: { type: S.DATE, allowNull: true },
      approvedAt: { type: S.DATE, allowNull: true },
      receivedAt: { type: S.DATE, allowNull: true },
      refundedAt: { type: S.DATE, allowNull: true },
      history: { type: S.JSON, allowNull: true },
      ...stamps,
    });
    for (const col of ["orderId", "buyerId", "vendorId", "status"]) await queryInterface.addIndex("return_requests", [col]);

    await queryInterface.createTable("product_alerts", {
      id,
      userId: { ...ref(false), references: { model: "users", key: "id" }, onDelete: "CASCADE" },
      productId: { ...ref(false), references: { model: "products", key: "id" }, onDelete: "CASCADE" },
      kind: { type: S.ENUM("BACK_IN_STOCK", "PRICE_DROP"), allowNull: false },
      priceAtSignup: { type: S.DECIMAL(14, 2), allowNull: true },
      active: { type: S.BOOLEAN, allowNull: false, defaultValue: true },
      notifiedAt: { type: S.DATE, allowNull: true },
      ...stamps,
    });
    await queryInterface.addIndex("product_alerts", ["userId", "productId", "kind"], { unique: true });
    await queryInterface.addIndex("product_alerts", ["productId"]);
    await queryInterface.addIndex("product_alerts", ["active"]);

    await queryInterface.createTable("device_tokens", {
      id,
      userId: { ...ref(false), references: { model: "users", key: "id" }, onDelete: "CASCADE" },
      token: { type: S.STRING(500), allowNull: false, unique: true },
      platform: { type: S.ENUM("ANDROID", "IOS", "WEB"), allowNull: false, defaultValue: "ANDROID" },
      lastSeenAt: { type: S.DATE, allowNull: true },
      ...stamps,
    });
    await queryInterface.addIndex("device_tokens", ["userId"]);
  },

  async down(queryInterface) {
    for (const t of ["device_tokens", "product_alerts", "return_requests", "product_variants"]) await queryInterface.dropTable(t);
    for (const [t, c] of [["cart_items", "variantId"], ["order_items", "variantId"], ["order_items", "variantLabel"], ["order_items", "deal"],
      ["products", "dealPrice"], ["products", "dealStartsAt"], ["products", "dealEndsAt"], ["products", "dealQuantity"], ["products", "dealSold"],
      ["vendors", "documents"], ["suppliers", "documents"]]) await queryInterface.removeColumn(t, c);
  },
};
