/**
 * How much of a care location each side may see, and when.
 *
 * A caregiver needs to know roughly where a job is before deciding whether to take it — nobody
 * accepts work without knowing the neighbourhood. But V4 §23 and V5 §4 forbid handing over the
 * household's details before there is any relationship, and an exact coordinate is the address.
 *
 * So location is disclosed in two stages:
 *
 *   APPROXIMATE  before acceptance — the centre is rounded to a ~1 km grid and returned with a
 *                radius, so the map shows an area, not a house. Enough to judge the trip.
 *   EXACT        once the job request is accepted — the real pin plus the geofence circle the
 *                monitoring rules actually evaluate against.
 *
 * The family always sees their own exact location; the rounding applies only to what is sent to a
 * caregiver who has not yet been accepted.
 */

/** Roughly one kilometre in degrees at Thailand's latitude. */
const GRID_DEG = 0.01;

/** Radius shown around an approximate location, in metres. */
export const APPROX_RADIUS_M = 900;

const round = (v, step) => Math.round(v / step) * step;

/**
 * Snap a coordinate to a grid so the point identifies an area rather than an address.
 * Deterministic: the same house always yields the same circle, so a caregiver comparing two jobs
 * is not misled by a centre that moves between page loads.
 */
export function approximate(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    latitude: Number(round(lat, GRID_DEG).toFixed(5)),
    longitude: Number(round(lng, GRID_DEG).toFixed(5)),
    radius_m: APPROX_RADIUS_M,
    precision: 'APPROXIMATE',
    note: 'ตำแหน่งโดยประมาณ จะเห็นตำแหน่งจริงเมื่อตอบรับงานแล้ว',
  };
}

export function exact(lat, lng, geofenceRadiusM = 150) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    latitude: Number(Number(lat).toFixed(6)),
    longitude: Number(Number(lng).toFixed(6)),
    radius_m: Number(geofenceRadiusM) || 150,
    precision: 'EXACT',
    note: 'พื้นที่ดูแลตามรัศมีที่ตั้งไว้ ระบบแจ้งเตือนเมื่อออกนอกวงนี้',
  };
}

/**
 * Pick the right disclosure for a viewer.
 * @param {object} careRequest
 * @param {'FAMILY'|'CAREGIVER'} viewer
 * @param {boolean} accepted  whether this caregiver has been accepted for the job
 */
export function locationFor(careRequest, viewer, accepted = false) {
  if (!careRequest) return null;
  const { latitude, longitude, geofence_radius_m } = careRequest;
  if (viewer === 'FAMILY' || accepted) {
    return exact(latitude, longitude, geofence_radius_m ?? 150);
  }
  return approximate(latitude, longitude);
}

/** Metres between two points — used to decide whether a GPS fix is inside the geofence. */
export function distanceMetres(a, b) {
  if (!a || !b) return null;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat));
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Is a reported position inside the geofence? Returns null when either side is unknown. */
export function insideGeofence(position, careRequest) {
  if (!position || !careRequest) return null;
  const d = distanceMetres(
    { lat: position.lat, lng: position.lng },
    { lat: careRequest.latitude, lng: careRequest.longitude },
  );
  if (d == null) return null;
  return d <= (Number(careRequest.geofence_radius_m) || 150);
}
