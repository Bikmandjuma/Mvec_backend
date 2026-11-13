"use strict";

// Ikiguzi riders, as in KitchenLink: stores set a pickup pin and choose rider
// delivery, buyers drop a pin, and each seller's parcel of a paid order becomes
// a delivery job offered to the nearest approved, online rider.
module.exports = {
  async up(queryInterface, Sequelize) {
    const S = Sequelize;
    const pin = { type: S.DECIMAL(9, 6), allowNull: true };
    const now = { type: S.DATE(3), allowNull: false, defaultValue: S.literal("CURRENT_TIMESTAMP(3)") };

    await queryInterface.addColumn("stores", "pickupLat", pin);
    await queryInterface.addColumn("stores", "pickupLng", pin);
    await queryInterface.addColumn("stores", "riderDelivery", { type: S.BOOLEAN, allowNull: false, defaultValue: false });
    await queryInterface.addColumn("orders", "shippingAddressLat", pin);
    await queryInterface.addColumn("orders", "shippingAddressLng", pin);
    // Admins no longer hand-assign couriers to orders: riders take parcel jobs.
    await queryInterface.removeColumn("orders", "courierId");
    await queryInterface.addColumn("user_addresses", "lat", pin);
    await queryInterface.addColumn("user_addresses", "lng", pin);

    await queryInterface.createTable("riders", {
      id: { type: S.CHAR(24), primaryKey: true, allowNull: false },
      userId: { type: S.CHAR(24), allowNull: false, unique: true },
      vehicleType: { type: S.ENUM("MOTORBIKE", "BICYCLE", "CAR", "ON_FOOT"), allowNull: false, defaultValue: "MOTORBIKE" },
      plateNumber: { type: S.STRING(20), allowNull: true },
      status: { type: S.ENUM("PENDING", "APPROVED", "REJECTED", "SUSPENDED"), allowNull: false, defaultValue: "PENDING" },
      reviewNote: { type: S.STRING(300), allowNull: true },
      isOnline: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
      lat: pin,
      lng: pin,
      locationAt: { type: S.DATE(3), allowNull: true },
      createdAt: now,
      updatedAt: now,
    });
    await queryInterface.addIndex("riders", ["status", "isOnline"]);

    await queryInterface.createTable("deliveries", {
      id: { type: S.CHAR(24), primaryKey: true, allowNull: false },
      orderId: { type: S.CHAR(24), allowNull: false },
      vendorId: { type: S.CHAR(24), allowNull: false },
      storeId: { type: S.CHAR(24), allowNull: true },
      riderId: { type: S.CHAR(24), allowNull: true },
      status: { type: S.ENUM("READY_FOR_PICKUP", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"), allowNull: false, defaultValue: "READY_FOR_PICKUP" },
      pickupLat: { ...pin, allowNull: false },
      pickupLng: { ...pin, allowNull: false },
      pickupName: { type: S.STRING(150), allowNull: false },
      pickupAddress: { type: S.STRING(255), allowNull: true },
      dropLat: { ...pin, allowNull: false },
      dropLng: { ...pin, allowNull: false },
      dropAddress: { type: S.STRING(255), allowNull: true },
      distanceKm: { type: S.DECIMAL(6, 1), allowNull: false, defaultValue: 0 },
      fee: { type: S.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
      offers: { type: S.JSON, allowNull: true },
      rejectedBy: { type: S.JSON, allowNull: true },
      offerExpiresAt: { type: S.DATE(3), allowNull: true },
      codeAttempts: { type: S.INTEGER, allowNull: false, defaultValue: 0 },
      proofPhotoUrl: { type: S.STRING(500), allowNull: true },
      history: { type: S.JSON, allowNull: true },
      assignedAt: { type: S.DATE(3), allowNull: true },
      pickedUpAt: { type: S.DATE(3), allowNull: true },
      deliveredAt: { type: S.DATE(3), allowNull: true },
      createdAt: now,
      updatedAt: now,
    });
    await queryInterface.addIndex("deliveries", ["orderId", "vendorId"], { unique: true });
    await queryInterface.addIndex("deliveries", ["status"]);
    await queryInterface.addIndex("deliveries", ["riderId", "status"]);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn("orders", "courierId", { type: Sequelize.CHAR(24), allowNull: true });
    await queryInterface.dropTable("deliveries");
    await queryInterface.dropTable("riders");
    for (const [table, column] of [["user_addresses", "lng"], ["user_addresses", "lat"], ["orders", "shippingAddressLng"], ["orders", "shippingAddressLat"], ["stores", "riderDelivery"], ["stores", "pickupLng"], ["stores", "pickupLat"]]) {
      await queryInterface.removeColumn(table, column);
    }
  },
};
