// Ikiguzi riders: how parcels are priced, offered and tracked. Same rules and
// starting values as KitchenLink's delivery workers; each can be changed in .env.
// The rider keeps the whole delivery fee of each parcel they deliver.
const num = (key, fallback) => {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && process.env[key] !== "" ? n : fallback;
};

const settings = () => ({
  // fee = max(min, base + perKm × road km), road km = straight line × roadFactor
  baseFee: num("DELIVERY_BASE_FEE_RWF", 500),
  perKmFee: num("DELIVERY_PER_KM_FEE_RWF", 200),
  minFee: num("DELIVERY_MIN_FEE_RWF", 800),
  roadFactor: num("DELIVERY_ROAD_FACTOR", 1.3),
  // Farther than this from the store, the seller's own delivery zones apply.
  maxKm: num("DELIVERY_PLATFORM_MAX_KM", 30),
  // Offers go to approved, online riders this close to the store…
  radiusKm: num("DELIVERY_RADIUS_KM", 8),
  // …whose position is this recent…
  locationMaxAgeMinutes: num("DELIVERY_LOCATION_MAX_AGE_MINUTES", 60),
  // …at most this many at once, each answering within this many seconds.
  maxOfferRecipients: num("DELIVERY_MAX_OFFER_RECIPIENTS", 50),
  offerTimeoutSeconds: num("DELIVERY_OFFER_TIMEOUT_SECONDS", 45),
  // After accepting, the rider has this long to collect the parcel: reminded
  // this many minutes before, flagged at the deadline, and the parcel goes to
  // another rider this long after it.
  pickupMinutes: num("DELIVERY_PICKUP_MINUTES", 30),
  pickupWarnMinutes: num("DELIVERY_PICKUP_WARN_MINUTES", 5),
  reassignAfterMinutes: num("DELIVERY_PICKUP_REASSIGN_MINUTES", 15),
  // Road routes for the live maps (OpenStreetMap roads); empty = straight lines.
  osrmUrl: process.env.OSRM_URL ?? "https://router.project-osrm.org",
  // A rider carries one parcel at a time.
  maxActive: 1,
  codeMaxAttempts: 5,
});

// A parcel's life, and which step may follow which.
const STATUSES = ["READY_FOR_PICKUP", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"];
const RIDER_STEPS = { ASSIGNED: ["PICKED_UP"], PICKED_UP: ["OUT_FOR_DELIVERY"], OUT_FOR_DELIVERY: [] };
const ACTIVE = ["ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY"];

const LABELS = {
  READY_FOR_PICKUP: "Waiting for a rider",
  ASSIGNED: "Rider on the way to the store",
  PICKED_UP: "Picked up",
  OUT_FOR_DELIVERY: "On the way to the buyer",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

const toRad = (d) => (d * Math.PI) / 180;
function haversineKm(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

/** Road distance (km, one decimal) and fee (whole RWF) between two points. */
function quote(from, to, s = settings()) {
  const km = Math.round(haversineKm(from.lat, from.lng, to.lat, to.lng) * s.roadFactor * 10) / 10;
  const fee = Math.round(Math.max(s.minFee, s.baseFee + s.perKmFee * km));
  return { km, fee, withinRange: km <= s.maxKm };
}

// Rwanda's bounding box: a pin outside it is a mistake (or a faked position).
const inRwanda = (lat, lng) => lat >= -2.85 && lat <= -1.04 && lng >= 28.85 && lng <= 30.9;

/** { lat, lng } from a body, or null when absent. Throws a 400 for a bad pin. */
function readPin(body = {}, { required = false, label = "location" } = {}) {
  const lat = body.lat ?? body.latitude;
  const lng = body.lng ?? body.longitude;
  if ((lat === undefined || lat === null || lat === "") && (lng === undefined || lng === null || lng === "")) {
    if (required) throw Object.assign(new Error(`Set the ${label} on the map.`), { statusCode: 400 });
    return null;
  }
  const point = { lat: Number(lat), lng: Number(lng) };
  if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng) || !inRwanda(point.lat, point.lng)) {
    throw Object.assign(new Error(`The ${label} must be a place in Rwanda.`), { statusCode: 400 });
  }
  return point;
}

module.exports = { settings, STATUSES, RIDER_STEPS, ACTIVE, LABELS, haversineKm, quote, readPin, inRwanda };
