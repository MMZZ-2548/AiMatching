/**
 * Geography and travel.
 *
 * The engine accepts an optional travel matrix (used by the Strathclyde adapter, which ships a
 * real observed travel-time matrix). When no matrix entry exists it falls back to haversine
 * distance and an assumed average speed — and callers must label that as an assumption, not as
 * data from the dataset (V6 §16: for missing dataset features, status = NOT_AVAILABLE_IN_DATASET).
 */

const EARTH_RADIUS_KM = 6371;
export const ASSUMED_SPEED_KMH = Number(process.env.ASSUMED_SPEED_KMH ?? 30);

export function haversineKm(a, b) {
  if (!isFinite(a?.lat) || !isFinite(a?.lng) || !isFinite(b?.lat) || !isFinite(b?.lng)) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

/**
 * Resolve distance + travel time between a caregiver base and a care location.
 * `matrix` is an optional { get(fromKey, toKey) -> seconds } provider.
 */
export function resolveTravel(caregiver, careRequest, matrix = null) {
  const fromKey = caregiver.location_key ?? caregiver.id;
  const toKey = careRequest.location_key ?? careRequest.id;

  if (matrix) {
    const seconds = matrix.get(fromKey, toKey);
    if (seconds != null) {
      const minutes = seconds / 60;
      return {
        distance_km: (minutes / 60) * ASSUMED_SPEED_KMH,
        travel_minutes: minutes,
        source: 'MATRIX',
      };
    }
  }

  const km = haversineKm(
    { lat: caregiver.base_latitude, lng: caregiver.base_longitude },
    { lat: careRequest.latitude, lng: careRequest.longitude },
  );
  if (km == null) return { distance_km: null, travel_minutes: null, source: 'UNKNOWN' };
  return {
    distance_km: km,
    travel_minutes: (km / ASSUMED_SPEED_KMH) * 60,
    source: 'HAVERSINE',
  };
}

/**
 * SCORING_SPEC §7 — distance score curve.
 * Continuous, 100 at half the radius, exactly 40 at the radius boundary, 0 at 3× radius.
 */
export function distanceFit(distanceKm, serviceRadiusKm) {
  if (distanceKm == null || !(serviceRadiusKm > 0)) return null;
  const half = serviceRadiusKm / 2;
  if (distanceKm <= half) return 100;
  if (distanceKm <= serviceRadiusKm) return 100 - (60 * (distanceKm - half)) / half;
  return Math.max(0, 40 - (40 * (distanceKm - serviceRadiusKm)) / (2 * serviceRadiusKm));
}

export function travelTimeFit(travelMinutes, maxTravelMinutes) {
  if (travelMinutes == null || !(maxTravelMinutes > 0)) return null;
  return Math.min(100, Math.max(0, 100 * (1 - travelMinutes / maxTravelMinutes)));
}

/** Build a matrix provider from a nested map, used by the benchmark adapters. */
export function matrixFrom(map) {
  return {
    get(from, to) {
      const row = map.get(String(from));
      if (!row) return null;
      const v = row.get(String(to));
      return v == null ? null : v;
    },
  };
}
