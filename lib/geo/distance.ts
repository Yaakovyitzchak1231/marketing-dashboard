/**
 * Pure distance helpers for radius search (TAP-171). No DB, no network.
 * The SQL twin of milesBetween is lp.miles_between (db/migrations/0070_company_geo.sql);
 * both use the haversine formula with the same Earth radius, so a distance shown
 * in the UI and the distance the database filtered on agree.
 */

export const EARTH_RADIUS_MILES = 3958.7613
/** Largest radius a condition may ask for. Bigger than a state, smaller than "everyone". */
export const MAX_RADIUS_MILES = 500

const toRad = (deg: number) => (deg * Math.PI) / 180

export function milesBetween(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(a)))
}

export interface BoundingBox {
  minLat: number
  maxLat: number
  /** null when the box would cross a pole or the antimeridian -- then only latitude prefilters. */
  minLng: number | null
  maxLng: number | null
}

/**
 * A box that is guaranteed to CONTAIN every point within `miles` of the centre, so it
 * can prefilter rows by index before the exact haversine check. It is a little too big
 * on purpose (never too small): a point inside the box may still be out of range, a
 * point outside it never is.
 */
export function boundingBox(lat: number, lng: number, miles: number): BoundingBox {
  const latDelta = (miles / EARTH_RADIUS_MILES) * (180 / Math.PI)
  const minLat = lat - latDelta
  const maxLat = lat + latDelta
  if (minLat <= -90 || maxLat >= 90) return { minLat: Math.max(-90, minLat), maxLat: Math.min(90, maxLat), minLng: null, maxLng: null }
  // Widest longitude span of the circle is at the latitude nearest a pole, not at the centre.
  const worstLat = Math.max(Math.abs(minLat), Math.abs(maxLat))
  const lngDelta = latDelta / Math.cos(toRad(worstLat))
  const minLng = lng - lngDelta
  const maxLng = lng + lngDelta
  if (minLng < -180 || maxLng > 180) return { minLat, maxLat, minLng: null, maxLng: null }
  return { minLat, maxLat, minLng, maxLng }
}

export function isValidLatLng(lat: unknown, lng: unknown): lat is number {
  return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}
