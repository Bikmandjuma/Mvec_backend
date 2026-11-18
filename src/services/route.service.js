// Road routes for the live delivery maps, as in KitchenLink: the OSRM routing
// service (OpenStreetMap roads) with turn-by-turn steps, and a straight line
// when it's switched off (OSRM_URL="") or doesn't answer, so maps keep working.
//
// Route: { source: "osrm"|"straight", distanceM, durationS,
//          geometry: [[lng, lat], ...], steps: [{ instruction, name, distanceM, maneuver }] }
const cfg = require("../config/delivery");

const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 500;
// The public OSRM server allows about one request a second.
const MIN_INTERVAL_MS = 1100;
// After a failure, straight lines for a minute instead of waiting on every refresh.
const BACKOFF_MS = 60 * 1000;
const cache = new Map();
let downUntil = 0;
let queue = Promise.resolve();
let lastCall = 0;

/** Runs `fn` no sooner than MIN_INTERVAL_MS after the previous OSRM call. */
function throttled(fn) {
  const run = queue.then(async () => {
    const wait = lastCall + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    return fn();
  });
  queue = run.catch(() => {});
  return run;
}

function instruction({ maneuver = {}, name }) {
  const { type, modifier, exit } = maneuver;
  const road = name || "the road";
  const onto = name ? ` onto ${name}` : "";
  const turn = modifier === "uturn" ? "Make a U-turn" : `Turn ${modifier || "ahead"}`;
  switch (type) {
    case "depart": return `Head ${modifier ? `${modifier} ` : ""}on ${road}`;
    case "arrive": return "You have arrived";
    case "turn": return modifier === "straight" ? `Continue straight${onto}` : `${turn}${onto}`;
    case "new name": return `Continue onto ${road}`;
    case "continue": return modifier && modifier !== "straight" ? `${turn} to stay on ${road}` : `Continue on ${road}`;
    case "end of road": return `At the end of the road, turn ${modifier || "ahead"}${onto}`;
    case "fork": return `Keep ${modifier || "ahead"} at the fork${onto}`;
    case "roundabout":
    case "rotary":
    case "roundabout turn": return exit ? `At the roundabout, take exit ${exit}${onto}` : `Go through the roundabout${onto}`;
    case "exit roundabout":
    case "exit rotary": return `Exit the roundabout${onto}`;
    default: return modifier ? `${turn}${onto}` : `Continue on ${road}`;
  }
}

async function osrm(from, to, baseUrl) {
  const url = new URL(`/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}`, baseUrl);
  url.searchParams.set("overview", "full");
  url.searchParams.set("geometries", "geojson");
  url.searchParams.set("steps", "true");
  const data = await throttled(async () => {
    const res = await fetch(url, { headers: { "User-Agent": "Ikiguzi delivery maps" }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
  const route = data?.routes?.[0];
  if (data?.code !== "Ok" || !route) throw new Error(data?.code || "no route");
  return {
    source: "osrm",
    distanceM: Math.round(route.distance),
    durationS: Math.round(route.duration),
    geometry: route.geometry.coordinates,
    steps: (route.legs?.[0]?.steps || []).map((step) => ({
      instruction: instruction(step),
      name: step.name || "",
      distanceM: Math.round(step.distance),
      maneuver: { type: step.maneuver?.type, modifier: step.maneuver?.modifier || null, location: step.maneuver?.location },
    })),
  };
}

function straight(from, to) {
  const km = cfg.haversineKm(from.lat, from.lng, to.lat, to.lng) * cfg.settings().roadFactor;
  return {
    source: "straight",
    distanceM: Math.round(km * 1000),
    // About 20 km/h through town on a motorbike.
    durationS: Math.round((km / 20) * 3600),
    geometry: [[from.lng, from.lat], [to.lng, to.lat]],
    steps: [{ instruction: "You have arrived", name: "", distanceM: 0, maneuver: { type: "arrive", modifier: null, location: [to.lng, to.lat] } }],
  };
}

/** The road route from `from` to `to` ({ lat, lng } each). Never throws. */
async function route(from, to) {
  const key = [from.lat, from.lng, to.lat, to.lng].map((n) => Number(n).toFixed(4)).join(",");
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const { osrmUrl } = cfg.settings();
  const value = osrmUrl && Date.now() >= downUntil ? await osrm(from, to, osrmUrl).catch((error) => {
    console.warn(`[route] OSRM failed, using straight lines for a minute: ${error.message}`);
    downUntil = Date.now() + BACKOFF_MS;
    return null;
  }) : null;
  if (!value) return straight(from, to);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

module.exports = { route };
