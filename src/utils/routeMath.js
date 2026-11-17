/**
 * Small geometry helpers for following a route ([[lng, lat], ...]) with a
 * GPS position. Distances are in metres; an equirectangular projection is
 * plenty accurate at city scale.
 */
const EARTH_M = 6371000;
const rad = (deg) => (deg * Math.PI) / 180;

/** Local x/y metres of `p` relative to `origin` ([lng, lat] pairs). */
function toXY(p, origin) {
  const x = rad(p[0] - origin[0]) * Math.cos(rad(origin[1])) * EARTH_M;
  const y = rad(p[1] - origin[1]) * EARTH_M;
  return [x, y];
}

function metres(a, b) {
  const [x, y] = toXY(b, a);
  return Math.hypot(x, y);
}

/**
 * Where `point` sits on the route: the nearest segment, how far off the
 * route it is, and the distance still to travel to the end.
 */
function locateOnRoute(point, geometry) {
  if (!Array.isArray(geometry) || geometry.length === 0) {
    return { offRouteM: Infinity, remainingM: 0, segment: 0, travelledM: 0 };
  }
  if (geometry.length === 1) {
    const d = metres(point, geometry[0]);
    return { offRouteM: d, remainingM: d, segment: 0, travelledM: 0 };
  }

  let best = { dist: Infinity, segment: 0, t: 0 };
  for (let i = 0; i < geometry.length - 1; i += 1) {
    const a = geometry[i];
    const [bx, by] = toXY(geometry[i + 1], a);
    const [px, py] = toXY(point, a);
    const len2 = bx * bx + by * by;
    const t = len2 > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
    const dist = Math.hypot(px - t * bx, py - t * by);
    if (dist < best.dist) best = { dist, segment: i, t };
  }

  let travelledM = 0;
  for (let i = 0; i < best.segment; i += 1) travelledM += metres(geometry[i], geometry[i + 1]);
  const segLen = metres(geometry[best.segment], geometry[best.segment + 1]);
  travelledM += segLen * best.t;

  let totalM = 0;
  for (let i = 0; i < geometry.length - 1; i += 1) totalM += metres(geometry[i], geometry[i + 1]);

  return {
    offRouteM: best.dist,
    segment: best.segment,
    travelledM,
    remainingM: Math.max(0, totalM - travelledM),
    totalM,
  };
}

module.exports = { metres, locateOnRoute };
