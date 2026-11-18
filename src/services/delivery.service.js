// Ikiguzi riders deliver sellers' parcels, the way KitchenLink's delivery
// workers deliver kitchens' orders:
//
//   seller marks its part ready → a delivery job per rider parcel
//   → offered to the nearest approved, online riders (first to accept wins)
//   → rider picks it up → heads to the buyer → confirms with the buyer's code
//   → the seller's money is released and the rider earns the parcel's fee.
//
// A rider who declines is never offered that parcel again; unanswered offers
// expire and the parcel is offered again (dispatch tick). A rider going
// offline before pickup hands the parcel back to the pool.
const orm = require("../database/orm");
const Delivery = require("../models/Delivery");
const Rider = require("../models/Rider");
const Order = require("../models/Order");
const Store = require("../models/Store");
const User = require("../models/User");
const VendorWallet = require("../models/VendorWallet");
const cfg = require("../config/delivery");
const handover = require("./handover.service");
const notifications = require("./notification.service");
const socketService = require("./socket.service");

const httpError = (statusCode, message, code) => Object.assign(new Error(message), { statusCode, code });
const idOf = (v) => String(v?._id || v?.id || v || "");
const money = (n) => `${new Intl.NumberFormat("en-RW").format(Math.round(Number(n) || 0))} RWF`;
const kigaliTime = (d) => new Date(d).toLocaleTimeString("en-GB", { timeZone: "Africa/Kigali", hour: "2-digit", minute: "2-digit" });

const addressLine = (a = {}) => [a.street, a.sector, a.district || a.city].filter(Boolean).join(", ");
const withHistory = (delivery, status, note) => [...(delivery.history || []), { status, at: new Date(), note: note || cfg.LABELS[status] }];

/* ----------------------------- serializing ----------------------------- */

/**
 * What a rider sees. Before accepting, only the pickup area and the fee: the
 * buyer's name, phone and exact address appear once the parcel is theirs.
 */
async function serialize(delivery, { rider = null, reveal = false, order = null } = {}) {
  const o = order || (await Order.findById(delivery.order).select("orderNumber recipient customer items").lean());
  const mine = reveal && rider && idOf(delivery.rider) === idOf(rider.user);
  const items = (o?.items || []).filter((i) => idOf(i.vendor) === idOf(delivery.vendor));
  const here = rider?.lat != null ? { lat: rider.lat, lng: rider.lng } : null;
  return {
    id: idOf(delivery),
    orderId: idOf(delivery.order),
    orderNumber: o?.orderNumber || "",
    status: delivery.status,
    statusLabel: cfg.LABELS[delivery.status],
    allowedNextStatuses: mine ? cfg.RIDER_STEPS[delivery.status] || [] : [],
    canConfirm: mine && delivery.status === "OUT_FOR_DELIVERY",
    fee: Number(delivery.fee) || 0,
    distanceKm: Number(delivery.distanceKm) || 0,
    distanceToPickupKm: here ? Math.round(cfg.haversineKm(here.lat, here.lng, delivery.pickupLat, delivery.pickupLng) * 10) / 10 : null,
    pickup: { name: delivery.pickupName, address: delivery.pickupAddress || "", lat: delivery.pickupLat, lng: delivery.pickupLng },
    dropoff: mine
      ? { address: delivery.dropAddress || "", lat: delivery.dropLat, lng: delivery.dropLng }
      : { address: (delivery.dropAddress || "").split(", ").slice(-1)[0] || "", lat: null, lng: null },
    customer: mine ? { name: o?.recipient?.name || o?.customer?.name || "Buyer", phone: o?.recipient?.phone || o?.customer?.phone || "" } : null,
    items: items.map((i) => ({ name: i.name, quantity: i.quantity })),
    offerExpiresAt: delivery.offerExpiresAt || null,
    assignedAt: delivery.assignedAt || null,
    pickedUpAt: delivery.pickedUpAt || null,
    deliveredAt: delivery.deliveredAt || null,
    createdAt: delivery.createdAt,
    history: delivery.history || [],
  };
}

const riderAccount = (rider, user) => ({
  id: idOf(rider),
  userId: idOf(rider.user),
  name: user?.Fullname || "",
  phone: user?.phone || "",
  vehicleType: rider.vehicleType,
  plateNumber: rider.plateNumber || "",
  status: rider.status,
  reviewNote: rider.reviewNote || "",
  isOnline: Boolean(rider.isOnline),
  location: rider.lat != null ? { lat: rider.lat, lng: rider.lng, at: rider.locationAt } : null,
});

/* ------------------------- creating and offering ------------------------ */

/**
 * Turns the rider parcels of `vendorIds` into delivery jobs and offers them.
 * Called when a seller marks its part of a paid order ready.
 */
async function createForOrder(order, vendorIds) {
  const created = [];
  const drop = order.shippingAddress?.lat != null ? { lat: order.shippingAddress.lat, lng: order.shippingAddress.lng } : null;
  for (const parcel of order.shippingBreakdown || []) {
    if (parcel.method !== "RIDER" || !vendorIds.includes(idOf(parcel.vendor)) || !drop) continue;
    if (await Delivery.findOne({ order: order._id, vendor: idOf(parcel.vendor) }).lean()) continue;
    const store = parcel.store ? await Store.findById(parcel.store).lean() : null;
    if (store?.pickupLat == null) continue;
    const { km } = cfg.quote({ lat: store.pickupLat, lng: store.pickupLng }, drop);
    const delivery = await Delivery.create({
      order: order._id,
      vendor: idOf(parcel.vendor),
      store: idOf(store),
      pickupLat: store.pickupLat,
      pickupLng: store.pickupLng,
      pickupName: store.storeName,
      pickupAddress: store.businessAddress || store.address?.street || "",
      dropLat: drop.lat,
      dropLng: drop.lng,
      dropAddress: addressLine(order.shippingAddress),
      distanceKm: km,
      fee: Number(parcel.fee) || 0,
      history: [{ status: "READY_FOR_PICKUP", at: new Date(), note: "Ready at the store" }],
    });
    created.push(delivery);
    await dispatch(delivery._id);
  }
  return created;
}

/** Riders who may be offered a job at `pickup` right now, nearest first. */
async function nearbyRiders(pickup, exclude) {
  const s = cfg.settings();
  const since = new Date(Date.now() - s.locationMaxAgeMinutes * 60 * 1000);
  const busy = new Set((await Delivery.find({ status: { $in: cfg.ACTIVE } }).select("rider").lean()).map((d) => idOf(d.rider)));
  const online = await Rider.find({ status: "APPROVED", isOnline: true, locationAt: { $gte: since } }).lean();
  return online
    .filter((r) => !exclude.has(idOf(r.user)) && !busy.has(idOf(r.user)))
    .map((r) => ({ rider: r, km: cfg.haversineKm(r.lat, r.lng, pickup.lat, pickup.lng) }))
    .filter((c) => c.km <= s.radiusKm)
    .sort((a, b) => a.km - b.km)
    .slice(0, s.maxOfferRecipients);
}

/** Offers an unassigned parcel to riders not yet asked. */
async function dispatch(deliveryId) {
  const delivery = await Delivery.findById(deliveryId);
  if (!delivery || delivery.rider || delivery.status !== "READY_FOR_PICKUP") return [];
  const s = cfg.settings();
  const asked = new Set([...(delivery.offers || []).map((o) => idOf(o.rider)), ...(delivery.rejectedBy || []).map(String)]);
  const candidates = await nearbyRiders({ lat: delivery.pickupLat, lng: delivery.pickupLng }, asked);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + s.offerTimeoutSeconds * 1000);
  delivery.offers = [
    ...(delivery.offers || []),
    ...candidates.map((c) => ({ rider: idOf(c.rider.user), offeredAt: now, expiresAt, response: "OFFERED" })),
  ];
  delivery.offerExpiresAt = expiresAt;
  await delivery.save();
  for (const c of candidates) {
    notifications.notify(c.rider.user, {
      type: "DELIVERY",
      title: `New delivery: ${money(delivery.fee)}`,
      message: `Pick up at ${delivery.pickupName}, ${Math.round(c.km * 10) / 10} km from you. Answer within ${s.offerTimeoutSeconds} seconds.`,
      link: "/delivery",
      sms: `Ikiguzi: new delivery at ${delivery.pickupName} (${money(delivery.fee)}). Open the app to accept.`,
    }).catch(() => {});
  }
  return candidates.map((c) => idOf(c.rider.user));
}

/** Offers whose time ran out go to the next riders (and to riders who came online). */
async function expireStaleOffers() {
  const stale = await Delivery.find({ status: "READY_FOR_PICKUP", rider: null, offerExpiresAt: { $lte: new Date() } }).select("_id").lean();
  for (const d of stale) await dispatch(d._id);
  return stale.length;
}

/* ------------------------------- the rider ------------------------------ */

async function riderOf(user) {
  const rider = await Rider.findOne({ user: idOf(user) });
  if (!rider) throw httpError(404, "Finish signing up as a rider first.", "RIDER_NOT_FOUND");
  return rider;
}

/** A rider must be approved (and not suspended) to see or take jobs. */
async function approvedRider(user) {
  const rider = await riderOf(user);
  if (rider.status !== "APPROVED") {
    throw httpError(403, {
      PENDING: "Your rider account is waiting for Ikiguzi's approval. You'll get a message once you can take deliveries.",
      REJECTED: `Your rider application was not approved${rider.reviewNote ? `: ${rider.reviewNote}` : "."}`,
      SUSPENDED: "Your rider account is suspended. Contact Ikiguzi support.",
    }[rider.status], `RIDER_${rider.status}`);
  }
  return rider;
}

async function profile(user) {
  const rider = await riderOf(user);
  return { rider: riderAccount(rider, await User.findById(idOf(user)).select("Fullname phone").lean()) };
}

async function register(user, body = {}) {
  if (await Rider.findOne({ user: idOf(user) }).lean()) throw httpError(409, "You're already signed up as a rider.");
  const vehicleType = String(body.vehicleType || "MOTORBIKE").toUpperCase();
  if (!["MOTORBIKE", "BICYCLE", "CAR", "ON_FOOT"].includes(vehicleType)) throw httpError(400, "Choose motorbike, bicycle, car or on foot.");
  const plateNumber = String(body.plateNumber || "").trim().toUpperCase().slice(0, 20);
  // Riders signing themselves up give their plate; an admin adding a rider vouches for them.
  if (!body.approved && ["MOTORBIKE", "CAR"].includes(vehicleType) && plateNumber.length < 4) throw httpError(400, "Enter your plate number.");
  const rider = await Rider.create({ user: idOf(user), vehicleType, plateNumber: plateNumber || undefined, status: body.approved ? "APPROVED" : "PENDING" });
  if (!body.approved) {
    notifications.adminAlert({ title: "New rider to approve", message: "A rider signed up and is waiting for approval.", link: "/admin/riders" }).catch(() => {});
  }
  return rider;
}

/** A reading from the phone's GPS, or null when it's missing or out of range. */
const reading = (value, min, max) => {
  const n = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(n) || n < min || n > max ? null : n;
};

async function updateLocation(user, body = {}) {
  const rider = await riderOf(user);
  const point = cfg.readPin(body, { required: true, label: "your location" });
  rider.lat = point.lat;
  rider.lng = point.lng;
  rider.heading = reading(body.heading, 0, 360);
  rider.speedMps = reading(body.speedMps ?? body.speed, 0, 70);
  rider.accuracyM = reading(body.accuracyM ?? body.accuracy, 0, 10000);
  rider.locationAt = new Date();
  await rider.save();
  return { location: { lat: point.lat, lng: point.lng, at: rider.locationAt } };
}

/**
 * Takes a parcel back from the rider who accepted it (before pickup) and
 * offers it to other riders; never back to that rider.
 */
async function handBack(delivery, note) {
  const riderId = idOf(delivery.rider);
  delivery.rider = null;
  delivery.status = "READY_FOR_PICKUP";
  delivery.assignedAt = null;
  delivery.pickupWarnedAt = null;
  delivery.lateAt = null;
  delivery.offerExpiresAt = null;
  delivery.rejectedBy = [...new Set([...(delivery.rejectedBy || []).map(String), riderId])];
  delivery.history = withHistory(delivery, "READY_FOR_PICKUP", note);
  await delivery.save();
  await dispatch(delivery._id);
  return riderId;
}

/** Going offline hands parcels not yet picked up back to the pool. */
async function setAvailability(user, body = {}) {
  const rider = await approvedRider(user);
  rider.isOnline = body.isOnline === undefined ? !rider.isOnline : Boolean(body.isOnline);
  await rider.save();
  let handedBack = 0;
  if (!rider.isOnline) {
    const assigned = await Delivery.find({ rider: idOf(user), status: "ASSIGNED" });
    for (const delivery of assigned) {
      await handBack(delivery, "The rider went offline; offered to others");
      handedBack += 1;
    }
  }
  return { rider: riderAccount(rider, await User.findById(idOf(user)).select("Fullname phone").lean()), handedBack };
}

const wasOffered = (delivery, userId) => (delivery.offers || []).some((o) => idOf(o.rider) === userId);

/** Jobs this rider may take: offered to them, or open and within range now. */
async function listAvailable(user) {
  const rider = await approvedRider(user);
  if (!rider.isOnline) return { deliveries: [], online: false, radiusKm: cfg.settings().radiusKm };
  const me = idOf(user);
  const { radiusKm } = cfg.settings();
  const open = await Delivery.find({ status: "READY_FOR_PICKUP", rider: null }).lean();
  const near = open
    .filter((d) => !(d.rejectedBy || []).map(String).includes(me))
    .map((d) => ({ d, km: rider.lat != null ? cfg.haversineKm(rider.lat, rider.lng, d.pickupLat, d.pickupLng) : null }))
    .filter(({ d, km }) => wasOffered(d, me) || (km != null && km <= radiusKm))
    .sort((a, b) => (a.km ?? 0) - (b.km ?? 0));
  return { deliveries: await Promise.all(near.map(({ d }) => serialize(d, { rider }))), online: true, radiusKm };
}

async function active(user) {
  const rider = await riderOf(user);
  const delivery = await Delivery.findOne({ rider: idOf(user), status: { $in: cfg.ACTIVE } }).sort({ assignedAt: -1 }).lean();
  return { delivery: delivery ? await serialize(delivery, { rider, reveal: true }) : null };
}

async function accept(user, deliveryId) {
  const rider = await approvedRider(user);
  if (!rider.isOnline) throw httpError(409, "Go online to take deliveries.");
  const me = idOf(user);
  if (await Delivery.findOne({ rider: me, status: { $in: cfg.ACTIVE } }).lean()) {
    throw httpError(409, "Finish your current delivery first.", "RIDER_BUSY");
  }
  const current = await Delivery.findById(deliveryId).lean();
  if (!current) throw httpError(404, "This delivery no longer exists.");
  const km = rider.lat != null ? cfg.haversineKm(rider.lat, rider.lng, current.pickupLat, current.pickupLng) : null;
  if (!wasOffered(current, me) && !(km != null && km <= cfg.settings().radiusKm)) {
    throw httpError(403, `This parcel is more than ${cfg.settings().radiusKm} km from you. Only nearby riders can take it.`, "DELIVERY_OUT_OF_RANGE");
  }
  const now = new Date();
  // First to accept wins: the update only applies while nobody has it.
  const claimed = await Delivery.updateOne(
    { _id: current._id, rider: null, status: "READY_FOR_PICKUP" },
    { $set: { rider: me, status: "ASSIGNED", assignedAt: now, pickupWarnedAt: null, lateAt: null } },
  );
  if (!claimed.modifiedCount) throw httpError(409, "Another rider already took this delivery.", "DELIVERY_ALREADY_ASSIGNED");

  const delivery = await Delivery.findById(current._id);
  delivery.offers = (delivery.offers || []).map((o) => ({ ...o, response: idOf(o.rider) === me ? "ACCEPTED" : o.response === "OFFERED" ? "EXPIRED" : o.response }));
  delivery.history = withHistory(delivery, "ASSIGNED", "A rider is heading to the store");
  await delivery.save();

  const name = (await User.findById(me).select("Fullname").lean())?.Fullname || "A rider";
  notifications.notify(delivery.vendor, {
    type: "DELIVERY", title: `${name} is coming for your parcel`, message: "Have the parcel ready for the Ikiguzi rider.", link: "/vendor/orders",
  }).catch(() => {});
  const due = new Date(now.getTime() + cfg.settings().pickupMinutes * 60 * 1000);
  return {
    delivery: await serialize(delivery, { rider, reveal: true }),
    message: `Head to ${delivery.pickupName}${km != null ? ` (${Math.round(km * 10) / 10} km away)` : ""} and collect it by ${kigaliTime(due)}.`,
  };
}

async function reject(user, deliveryId) {
  await approvedRider(user);
  const me = idOf(user);
  const delivery = await Delivery.findById(deliveryId);
  if (!delivery) throw httpError(404, "This delivery no longer exists.");
  if (delivery.rider && idOf(delivery.rider) !== me) throw httpError(409, "Another rider already took this delivery.");
  if (idOf(delivery.rider) === me) throw httpError(409, "You already accepted this delivery. Go offline to hand it back before pickup.");
  delivery.rejectedBy = [...new Set([...(delivery.rejectedBy || []).map(String), me])];
  delivery.offers = (delivery.offers || []).map((o) => (idOf(o.rider) === me ? { ...o, response: "DECLINED" } : o));
  await delivery.save();
  await dispatch(delivery._id);
  return { declined: true };
}

/** picked_up, then out for delivery: each step only from the one before it. */
async function updateStatus(user, deliveryId, body = {}) {
  const rider = await approvedRider(user);
  const delivery = await Delivery.findOne({ _id: deliveryId, rider: idOf(user) });
  if (!delivery) throw httpError(404, "This delivery isn't assigned to you.");
  const next = String(body.status || "").toUpperCase();
  if (!(cfg.RIDER_STEPS[delivery.status] || []).includes(next)) {
    throw httpError(409, `This delivery is ${cfg.LABELS[delivery.status].toLowerCase()}; that step isn't possible now.`, "INVALID_STEP");
  }
  const now = new Date();
  delivery.status = next;
  if (next === "PICKED_UP") delivery.pickedUpAt = now;
  delivery.history = withHistory(delivery, next);
  await delivery.save();

  // The order follows its parcels: shipped once one is collected, out for
  // delivery once one is on its way (sellers can't move rider parcels).
  const order = await Order.findById(delivery.order);
  const orderStep = next === "PICKED_UP" ? "SHIPPED" : "OUT_FOR_DELIVERY";
  const flow = ["CONFIRMED", "PROCESSING", "READY_FOR_SHIPMENT", "SHIPPED", "OUT_FOR_DELIVERY"];
  if (order && flow.indexOf(order.orderStatus) < flow.indexOf(orderStep)) {
    order.orderStatus = orderStep;
    if (!order.shippedAt) order.shippedAt = now;
    await order.save();
    socketService.emitOrderStatusUpdate(order);
  }
  if (order && next === "OUT_FOR_DELIVERY") {
    notifications.notify(order.user, {
      type: "DELIVERY",
      title: `Your parcel from ${delivery.pickupName} is on its way`,
      message: "Give the rider your 6-digit delivery code only when you have the parcel in hand.",
      link: `/orders/${idOf(order)}`,
      sms: { phone: order.recipient?.phone, text: `Ikiguzi: your parcel from ${delivery.pickupName} is on its way. Give the rider your delivery code only when you have it.` },
    }).catch(() => {});
  }
  return { delivery: await serialize(delivery, { rider, reveal: true, order }) };
}

/** The buyer's 6-digit code (and an optional photo) completes the parcel. */
async function confirm(user, deliveryId, body = {}) {
  const rider = await approvedRider(user);
  const me = idOf(user);
  const delivery = await Delivery.findOne({ _id: deliveryId, rider: me });
  if (!delivery) throw httpError(404, "This delivery isn't assigned to you.");
  if (delivery.status !== "OUT_FOR_DELIVERY") {
    throw httpError(409, delivery.status === "DELIVERED" ? "This delivery is already confirmed." : "Start the delivery before confirming it.");
  }
  const { codeMaxAttempts } = cfg.settings();
  // Each try is counted atomically, so the code can't be guessed.
  const counted = await Delivery.updateOne({ _id: delivery._id, codeAttempts: { $lt: codeMaxAttempts } }, { $inc: { codeAttempts: 1 } });
  if (!counted.modifiedCount) throw httpError(423, "Too many wrong codes. Ikiguzi support must confirm this delivery.", "DELIVERY_CODE_LOCKED");

  const session = await orm.startSession();
  session.startTransaction();
  try {
    const order = await Order.findById(delivery.order).session(session);
    const code = String(body.code || "").trim();
    if (!order?.deliveryOtp || code !== order.deliveryOtp) {
      await session.abortTransaction();
      const left = codeMaxAttempts - (delivery.codeAttempts || 0) - 1;
      throw httpError(400, left > 0 ? `Wrong delivery code. ${left} attempt${left === 1 ? "" : "s"} left.` : "Wrong delivery code. This delivery is now locked for Ikiguzi support.", "CODE_INVALID");
    }
    if (order.paymentStatus !== "PAID" && order.paymentMethod !== "CASH_ON_DELIVERY") {
      await session.abortTransaction();
      throw httpError(409, "This order isn't paid, so it can't be delivered.");
    }
    const vendorId = idOf(delivery.vendor);
    const { complete } = await handover.handOver({ order, vendorIds: [vendorId], riders: { [vendorId]: me }, session });
    delivery.status = "DELIVERED";
    delivery.deliveredAt = new Date();
    if (body.proofPhotoUrl) delivery.proofPhotoUrl = String(body.proofPhotoUrl).slice(0, 500);
    delivery.history = withHistory(delivery, "DELIVERED", "Confirmed with the buyer's code");
    await delivery.save({ session });
    await session.commitTransaction();

    socketService.emitOrderStatusUpdate(order);
    notifications.orderDelivered(order, { complete, vendorIds: [vendorId] }).catch(() => {});
    return { delivery: await serialize(delivery, { rider, reveal: true, order }), earned: Number(delivery.fee) || 0 };
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
}

async function history(user, { page = 1, limit = 20 } = {}) {
  const rider = await riderOf(user);
  const size = Math.min(50, Math.max(1, Number(limit) || 20));
  const skip = (Math.max(1, Number(page) || 1) - 1) * size;
  const filter = { rider: idOf(user), status: "DELIVERED" };
  const [rows, total] = await Promise.all([
    Delivery.find(filter).sort({ deliveredAt: -1 }).skip(skip).limit(size).lean(),
    Delivery.countDocuments(filter),
  ]);
  return { deliveries: await Promise.all(rows.map((d) => serialize(d, { rider, reveal: true }))), total, page: Number(page) || 1 };
}

/** Today's and all-time deliveries and earnings (Kigali day). */
async function stats(user) {
  const rider = await riderOf(user);
  const done = await Delivery.find({ rider: idOf(user), status: "DELIVERED" }).select("fee deliveredAt").lean();
  const kigaliDay = (d) => new Date(new Date(d).getTime() + 2 * 3600 * 1000).toISOString().slice(0, 10);
  const today = kigaliDay(new Date());
  const todays = done.filter((d) => kigaliDay(d.deliveredAt) === today);
  const sum = (rows) => rows.reduce((n, d) => n + (Number(d.fee) || 0), 0);
  return {
    isOnline: Boolean(rider.isOnline),
    status: rider.status,
    todayDeliveries: todays.length,
    todayEarnings: sum(todays),
    totalDeliveries: done.length,
    totalEarnings: sum(done),
  };
}

/** Money earned from delivered parcels, and what can be withdrawn now. */
async function wallet(user) {
  await riderOf(user);
  const w = (await VendorWallet.findOne({ vendor: idOf(user) }).lean()) || {};
  return {
    wallet: {
      available: Number(w.availableBalance) || 0,
      totalEarned: Number(w.totalEarned) || 0,
      totalWithdrawn: Number(w.totalWithdrawn) || 0,
      minimumWithdrawal: 1000,
    },
  };
}

/* ----------------------------- late pickups ----------------------------- */

/**
 * Parcels accepted but not collected (every minute, as in KitchenLink): the
 * rider is reminded shortly before the deadline, flagged at it (rider and
 * admins are told), and the parcel goes to another rider a while after it.
 */
async function checkLatePickups(now = new Date()) {
  const s = cfg.settings();
  const minutes = (n) => n * 60 * 1000;
  const counts = { warned: 0, flagged: 0, reassigned: 0 };
  const waitingPickup = await Delivery.find({ status: "ASSIGNED", rider: { $ne: null } });
  for (const delivery of waitingPickup) {
    if (!delivery.assignedAt) continue;
    const dueAt = new Date(new Date(delivery.assignedAt).getTime() + minutes(s.pickupMinutes));
    const reassignAt = new Date(dueAt.getTime() + minutes(s.reassignAfterMinutes));
    const riderId = idOf(delivery.rider);
    if (now >= reassignAt) {
      await handBack(delivery, `Not collected by ${kigaliTime(dueAt)}; offered to other riders`);
      notifications.notify(riderId, {
        type: "DELIVERY", title: "Delivery given to another rider",
        message: `You didn't collect the parcel at ${delivery.pickupName} in time, so it went to another rider.`,
        link: "/delivery", sms: `Ikiguzi: you didn't collect the parcel at ${delivery.pickupName} in time. It went to another rider.`,
      }).catch(() => {});
      notifications.notify(delivery.vendor, {
        type: "DELIVERY", title: "A new rider is being found",
        message: "The rider didn't come in time. Ikiguzi is offering your parcel to other riders.", link: "/vendor/orders",
      }).catch(() => {});
      counts.reassigned += 1;
    } else if (now >= dueAt && !delivery.lateAt) {
      delivery.lateAt = now;
      delivery.history = withHistory(delivery, "ASSIGNED", `Not collected by ${kigaliTime(dueAt)}: late pickup`);
      await delivery.save();
      notifications.notify(riderId, {
        type: "DELIVERY", title: "Late pickup",
        message: `Collect the parcel at ${delivery.pickupName} now. At ${kigaliTime(reassignAt)} it goes to another rider.`,
        link: "/delivery/trip", sms: `Ikiguzi: collect the parcel at ${delivery.pickupName} now. At ${kigaliTime(reassignAt)} it goes to another rider.`,
      }).catch(() => {});
      notifications.adminAlert({
        title: "Late pickup",
        message: `A rider hasn't collected a parcel at ${delivery.pickupName}. It is re-offered at ${kigaliTime(reassignAt)}, or hand it back now.`,
        link: "/admin/deliveries",
      }).catch(() => {});
      counts.flagged += 1;
    } else if (now >= new Date(dueAt.getTime() - minutes(s.pickupWarnMinutes)) && !delivery.pickupWarnedAt && !delivery.lateAt) {
      delivery.pickupWarnedAt = now;
      await delivery.save();
      const left = Math.max(1, Math.ceil((dueAt - now) / 60000));
      notifications.notify(riderId, {
        type: "DELIVERY", title: `${left} minute${left === 1 ? "" : "s"} left to collect`,
        message: `Collect the parcel at ${delivery.pickupName} by ${kigaliTime(dueAt)}.`,
        link: "/delivery/trip", sms: `Ikiguzi: collect the parcel at ${delivery.pickupName} by ${kigaliTime(dueAt)}.`,
      }).catch(() => {});
      counts.warned += 1;
    }
  }
  return counts;
}

/** Admin: takes a parcel back from a rider who hasn't collected it and offers it to others. */
async function adminRelease(deliveryId, { note } = {}) {
  const delivery = await Delivery.findById(deliveryId);
  if (!delivery) throw httpError(404, "This delivery no longer exists.");
  if (delivery.status !== "ASSIGNED") {
    throw httpError(409, delivery.status === "READY_FOR_PICKUP" ? "No rider has this parcel yet." : "The rider already collected this parcel; it can't be handed to someone else now.");
  }
  const reason = String(note || "").trim().slice(0, 200);
  const riderId = await handBack(delivery, `Ikiguzi gave the parcel to another rider${reason ? `: ${reason}` : ""}`);
  notifications.notify(riderId, {
    type: "DELIVERY", title: "Delivery given to another rider",
    message: `Ikiguzi gave the parcel at ${delivery.pickupName} to another rider${reason ? `: ${reason}` : "."} Don't collect it.`,
    link: "/delivery", sms: `Ikiguzi: the parcel at ${delivery.pickupName} went to another rider. Don't collect it.`,
  }).catch(() => {});
  return { released: true };
}

/* -------------------------------- sellers ------------------------------- */

/** Parcels of an order cancelled before delivery are withdrawn from riders. */
async function cancelForOrder(orderId) {
  const open = await Delivery.find({ order: orderId, status: { $in: ["READY_FOR_PICKUP", ...cfg.ACTIVE] } });
  for (const delivery of open) {
    if (delivery.rider) {
      notifications.notify(delivery.rider, { type: "DELIVERY", title: "Delivery cancelled", message: `The order for ${delivery.pickupName} was cancelled. Don't collect it.`, link: "/delivery" }).catch(() => {});
    }
    delivery.status = "CANCELLED";
    delivery.history = withHistory(delivery, "CANCELLED", "The order was cancelled");
    await delivery.save();
  }
}

/** Whether a rider (not the seller) carries this seller's parcel of the order. */
const isRiderParcel = (order, vendorId) =>
  (order.shippingBreakdown || []).some((p) => p.method === "RIDER" && idOf(p.vendor) === String(vendorId));

/* --------------------------------- admin -------------------------------- */

async function listRiders({ status } = {}) {
  const riders = await Rider.find(status ? { status } : {}).sort({ createdAt: -1 }).lean();
  const users = await User.find({ _id: { $in: riders.map((r) => idOf(r.user)) } }).select("Fullname phone").lean();
  const byId = new Map(users.map((u) => [idOf(u), u]));
  return { riders: riders.map((r) => riderAccount(r, byId.get(idOf(r.user)))) };
}

async function reviewRider(riderId, { status, note } = {}) {
  const next = String(status || "").toUpperCase();
  if (!["APPROVED", "REJECTED", "SUSPENDED"].includes(next)) throw httpError(400, "Choose approve, reject or suspend.");
  if (next !== "APPROVED" && String(note || "").trim().length < 5) throw httpError(400, "Say why, so the rider knows what to fix.");
  const rider = await Rider.findById(riderId);
  if (!rider) throw httpError(404, "Rider not found.");
  rider.status = next;
  rider.reviewNote = next === "APPROVED" ? null : String(note).trim().slice(0, 300);
  if (next !== "APPROVED") rider.isOnline = false;
  await rider.save();
  const text = { APPROVED: "You're approved. Go online in the Ikiguzi app to start taking deliveries.", REJECTED: `Your rider application was not approved: ${rider.reviewNote}`, SUSPENDED: `Your rider account was suspended: ${rider.reviewNote}` }[next];
  notifications.notify(rider.user, { type: "SYSTEM", title: "Your rider account", message: text, link: "/delivery", sms: `Ikiguzi: ${text}` }).catch(() => {});
  return { rider: riderAccount(rider, await User.findById(idOf(rider.user)).select("Fullname phone").lean()) };
}

module.exports = {
  createForOrder, dispatch, expireStaleOffers, checkLatePickups, cancelForOrder, isRiderParcel,
  register, profile, updateLocation, setAvailability, listAvailable, active, accept, reject, updateStatus, confirm, history, stats, wallet,
  listRiders, reviewRider, adminRelease,
};
