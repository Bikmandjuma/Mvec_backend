// Live delivery tracking, as in KitchenLink: where the rider is, the road route
// to where they're going (the store first, then the buyer), how far and how
// long is left. The buyer and the seller see it from the moment a rider
// accepts; the rider gets the same route with turn-by-turn steps.
const Delivery = require("../models/Delivery");
const Rider = require("../models/Rider");
const Order = require("../models/Order");
const User = require("../models/User");
const cfg = require("../config/delivery");
const { locateOnRoute } = require("../utils/routeMath");
const routeService = require("./route.service");

// Recompute the road route when the rider strays this far from it, or after this long.
const OFF_ROUTE_M = 60;
const ROUTE_MAX_AGE_MS = 90 * 1000;
// A position older than this is shown as "last seen".
const STALE_LOCATION_MS = 2 * 60 * 1000;

const PHASE_LABELS = { to_store: "Heading to the store", to_buyer: "On the way to the buyer" };
const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const idOf = (v) => String(v?._id || v?.id || v || "");
const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

// deliveryId -> { phase, route, at }: one route shared by everyone watching.
const routes = new Map();

function phaseOf(delivery) {
  if (delivery?.status === "ASSIGNED") return "to_store";
  if (["PICKED_UP", "OUT_FOR_DELIVERY"].includes(delivery?.status)) return "to_buyer";
  return null;
}

async function routeFor(delivery, phase, here, target) {
  const key = idOf(delivery);
  const cached = routes.get(key);
  const fits = cached && cached.phase === phase && Date.now() - cached.at < ROUTE_MAX_AGE_MS
    && locateOnRoute([here.lng, here.lat], cached.route.geometry).offRouteM <= OFF_ROUTE_M;
  if (fits) return cached.route;
  const route = await routeService.route(here, target);
  routes.set(key, { phase, route, at: Date.now() });
  if (routes.size > 1000) routes.delete(routes.keys().next().value);
  return route;
}

/** A parcel nobody is carrying yet (or anymore): its state, no map. */
const waiting = (delivery) => ({
  active: false,
  deliveryId: idOf(delivery),
  status: delivery.status,
  statusLabel: cfg.LABELS[delivery.status],
  store: { name: delivery.pickupName },
});

async function view(delivery, { withSteps = false, withRoute = true } = {}) {
  const phase = phaseOf(delivery);
  if (!phase || !delivery.rider) return waiting(delivery);
  const [rider, user, order] = await Promise.all([
    Rider.findOne({ user: idOf(delivery.rider) }).lean(),
    User.findById(idOf(delivery.rider)).select("Fullname phone").lean(),
    Order.findById(delivery.order).select("orderNumber").lean(),
  ]);
  const store = { name: delivery.pickupName, address: delivery.pickupAddress || "", lat: num(delivery.pickupLat), lng: num(delivery.pickupLng) };
  const destination = { address: delivery.dropAddress || "", lat: num(delivery.dropLat), lng: num(delivery.dropLng) };
  const target = phase === "to_store" ? store : destination;

  const at = rider?.locationAt ? new Date(rider.locationAt) : null;
  const location = rider?.lat != null && at
    ? {
        lat: num(rider.lat), lng: num(rider.lng),
        heading: num(rider.heading), speedMps: num(rider.speedMps), accuracyM: num(rider.accuracyM),
        at, stale: Date.now() - at.getTime() > STALE_LOCATION_MS,
      }
    : null;

  let route = null;
  if (location && withRoute) {
    const full = await routeFor(delivery, phase, location, target);
    const where = locateOnRoute([location.lng, location.lat], full.geometry);
    const share = where.totalM > 0 ? where.remainingM / where.totalM : 1;
    const durationS = Math.round(full.durationS * share);
    route = {
      source: full.source,
      geometry: full.geometry,
      distanceM: Math.round(where.remainingM + Math.min(where.offRouteM, OFF_ROUTE_M)),
      durationS,
      etaAt: new Date(Date.now() + durationS * 1000),
      ...(withSteps ? { steps: full.steps } : {}),
    };
  }

  return {
    active: true,
    deliveryId: idOf(delivery),
    orderId: idOf(delivery.order),
    orderNumber: order?.orderNumber || "",
    status: delivery.status,
    statusLabel: cfg.LABELS[delivery.status],
    // False while the seller is still preparing the parcel (the rider may already be on the way).
    ready: Boolean(delivery.readyAt),
    phase,
    phaseLabel: PHASE_LABELS[phase],
    rider: {
      name: user?.Fullname || "Ikiguzi rider",
      phone: user?.phone || "",
      vehicleType: rider?.vehicleType || null,
      plateNumber: rider?.plateNumber || "",
      location,
    },
    store,
    destination,
    target: phase === "to_store" ? "store" : "buyer",
    route,
    refreshAfterS: 4,
  };
}

/** GET /api/rider/deliveries/:id/navigation: the rider's own trip, with steps. */
async function riderNavigation(user, deliveryId) {
  const delivery = await Delivery.findOne({ _id: deliveryId, rider: idOf(user) }).lean();
  if (!delivery) throw httpError(404, "This delivery isn't assigned to you.");
  return view(delivery, { withSteps: true });
}

/**
 * GET /api/orders/:id/live: every rider parcel of the order the caller may
 * see. The buyer and admins see all of them; a seller only its own.
 */
async function orderLive(user, orderId, { vendorId } = {}) {
  const order = await Order.findById(orderId).select("user items").lean();
  if (!order) throw httpError(404, "Order not found.");
  const me = idOf(user);
  const isAdmin = user.role === "super_admin";
  const isBuyer = idOf(order.user) === me;
  const seller = vendorId || me;
  const sells = (order.items || []).some((i) => idOf(i.vendor) === seller);
  if (!isAdmin && !isBuyer && !sells) throw httpError(403, "Access denied.");

  const filter = { order: idOf(order), status: { $ne: "CANCELLED" } };
  if (!isAdmin && !isBuyer) filter.vendor = seller;
  const deliveries = await Delivery.find(filter).sort({ createdAt: 1 }).lean();
  return { parcels: await Promise.all(deliveries.map((d) => view(d))) };
}

/** Admin: every parcel a rider is carrying now, for the live map (positions only, no routes). */
async function activeDeliveries() {
  const deliveries = await Delivery.find({ status: { $in: cfg.ACTIVE } }).sort({ assignedAt: 1 }).lean();
  const waitingCount = await Delivery.countDocuments({ status: "READY_FOR_PICKUP" });
  return { deliveries: await Promise.all(deliveries.map((d) => view(d, { withRoute: false }))), waitingForRider: waitingCount };
}

module.exports = { riderNavigation, orderLive, activeDeliveries, phaseOf };
