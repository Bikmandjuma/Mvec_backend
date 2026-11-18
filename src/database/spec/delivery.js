// Ikiguzi riders and their delivery jobs (one per seller parcel of an order).
const { ref, str, int, num, money, bool, date, en, json } = require("./fields");
const { STATUSES } = require("../../config/delivery");

module.exports = [
  {
    model: "Rider", table: "riders", collection: "riders",
    fields: {
      user: ref("users", { required: true, unique: true, fk: false }),
      vehicleType: en(["MOTORBIKE", "BICYCLE", "CAR", "ON_FOOT"], { default: "MOTORBIKE", required: true }),
      plateNumber: str({ len: 20 }),
      status: en(["PENDING", "APPROVED", "REJECTED", "SUSPENDED"], { default: "PENDING", required: true }),
      reviewNote: str({ len: 300 }),
      isOnline: bool(false),
      lat: num(),
      lng: num(),
      locationAt: date(),
      // From the phone's GPS with each fix, when it has them.
      heading: num(),
      speedMps: num(),
      accuracyM: num(),
    },
  },
  {
    model: "Delivery", table: "deliveries", collection: "deliveries",
    fields: {
      order: ref("orders", { required: true, fk: false }),
      vendor: ref("users", { required: true, fk: false }),
      store: ref("stores", { fk: false }),
      rider: ref("users", { fk: false }),
      status: en(STATUSES, { default: "READY_FOR_PICKUP", required: true }),
      pickupLat: num({ required: true }),
      pickupLng: num({ required: true }),
      pickupName: str({ len: 150, required: true }),
      pickupAddress: str({ len: 255 }),
      dropLat: num({ required: true }),
      dropLng: num({ required: true }),
      dropAddress: str({ len: 255 }),
      distanceKm: num({ required: true, default: 0 }),
      fee: money({ required: true, default: 0 }),
      // [{ rider, offeredAt, expiresAt, response: OFFERED|ACCEPTED|DECLINED|EXPIRED }]
      offers: json([]),
      rejectedBy: json([]),
      offerExpiresAt: date(),
      codeAttempts: int({ required: true, default: 0 }),
      proofPhotoUrl: str({ len: 500 }),
      // [{ status, at, note }]
      history: json([]),
      assignedAt: date(),
      // When the seller marked the parcel ready. Parcels are offered as soon as
      // the buyer pays (null until ready), so a rider can head over early.
      readyAt: date(),
      // Late pickup: reminded shortly before the deadline, flagged at it.
      pickupWarnedAt: date(),
      lateAt: date(),
      pickedUpAt: date(),
      deliveredAt: date(),
    },
  },
];
