/**
 * Turn what a person typed ("21215", "Baltimore, MD", "Towson Town Center") into a
 * point, for radius search (TAP-171). Free and keyless, in this order:
 *
 *   1. a US ZIP          -> lp.postal_centroids (GeoNames, loaded by the geo_load_centroids op (lib/geo/geonames.ts))
 *   2. "City, ST"        -> the average of that city's ZIP centroids, same table
 *   3. anything else     -> OpenStreetMap Nominatim (https://nominatim.org, no key; its
 *                           usage policy asks for <= 1 request/second and an identifying
 *                           User-Agent -- we send one request per new place, and cache it)
 *
 * Every answer (including "not found") is cached in lp.geocode_cache, so the same
 * place is never looked up twice. Nothing here invents a position: no answer is
 * `null`, never 0,0.
 */
import type { Queryable } from '../db/types.ts'
import { isValidLatLng } from './distance.ts'

export interface GeoPoint {
  lat: number
  lng: number
  /** What the place resolved to, in words ("Baltimore, MD 21215"). */
  label: string
  source: 'postal_centroid' | 'city_centroid' | 'nominatim'
}

export type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
}>

export interface GeocodeOptions {
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: FetchLike
  /** Skip the network step (tests, or a caller that only wants table answers). */
  offline?: boolean
}

export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search'
const USER_AGENT = 'TapDash-marketing-dashboard/1.0 (radius search; https://github.com/Yaakovyitzchak1231/marketing-dashboard)'
const MAX_PLACE_CHARS = 200

let lastNominatim = Promise.resolve()
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = lastNominatim.then(fn)
  lastNominatim = run.then(() => new Promise((r) => setTimeout(r, 1100)), () => new Promise((r) => setTimeout(r, 1100)))
  return run
}

export class GeocodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GeocodeError'
  }
}

export function normalizePlace(place: string): string {
  return place.trim().replace(/\s+/g, ' ').toLowerCase()
}

const ZIP_RE = /^(\d{5})(?:-\d{4})?$/
const CITY_STATE_RE = /^(.+?),\s*([a-z]{2}|[a-z][a-z .]+)$/i

async function fromCache(db: Queryable, key: string): Promise<GeoPoint | null | undefined> {
  const { rows } = await db.query<{ latitude: number | null; longitude: number | null; label: string | null; source: string; found: boolean }>(
    `select latitude, longitude, label, source, found from lp.geocode_cache where query_norm = $1`,
    [key],
  )
  const r = rows[0]
  if (!r) return undefined
  if (!r.found || r.latitude == null || r.longitude == null) return null
  return { lat: Number(r.latitude), lng: Number(r.longitude), label: r.label ?? key, source: r.source as GeoPoint['source'] }
}

async function toCache(db: Queryable, key: string, p: GeoPoint | null, source: GeoPoint['source']): Promise<void> {
  await db.query(
    `insert into lp.geocode_cache (query_norm, latitude, longitude, label, source, found)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (query_norm) do update set latitude = excluded.latitude, longitude = excluded.longitude,
       label = excluded.label, source = excluded.source, found = excluded.found, created_at = now()`,
    [key, p?.lat ?? null, p?.lng ?? null, p?.label ?? null, p?.source ?? source, p != null],
  )
}

async function fromZip(db: Queryable, zip: string): Promise<GeoPoint | null> {
  const { rows } = await db.query<{ latitude: number; longitude: number; place_name: string | null; admin1_code: string | null }>(
    `select latitude, longitude, place_name, admin1_code from lp.postal_centroids where country = 'US' and postal_code = $1`,
    [zip],
  )
  const r = rows[0]
  if (!r) return null
  const where = [r.place_name, r.admin1_code].filter(Boolean).join(', ')
  return { lat: Number(r.latitude), lng: Number(r.longitude), label: where ? `${where} ${zip}` : zip, source: 'postal_centroid' }
}

async function fromCityState(db: Queryable, city: string, state: string): Promise<GeoPoint | null> {
  const { rows } = await db.query<{ lat: number | null; lng: number | null; n: number; place_name: string | null; admin1_code: string | null }>(
    `select avg(latitude) as lat, avg(longitude) as lng, count(*)::int as n, min(place_name) as place_name, min(admin1_code) as admin1_code
       from lp.postal_centroids
      where country = 'US' and lower(place_name) = lower($1)
        and (upper(admin1_code) = upper($2) or lower(admin1_name) = lower($2))`,
    [city.trim(), state.trim()],
  )
  const r = rows[0]
  if (!r || !r.n || r.lat == null || r.lng == null) return null
  return { lat: Number(r.lat), lng: Number(r.lng), label: `${r.place_name}, ${r.admin1_code}`, source: 'city_centroid' }
}

async function fromNominatim(place: string, fetchImpl: FetchLike): Promise<GeoPoint | null> {
  const url = `${NOMINATIM_URL}?format=jsonv2&limit=1&addressdetails=0&q=${encodeURIComponent(place)}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' }, signal: ctrl.signal })
    if (!res.ok) throw new GeocodeError(`The free geocoder (OpenStreetMap) answered HTTP ${res.status}; try a ZIP code or "City, ST".`)
    const body = (await res.json()) as Array<{ lat?: string; lon?: string; display_name?: string }>
    const hit = Array.isArray(body) ? body[0] : undefined
    if (!hit) return null
    const lat = Number(hit.lat)
    const lng = Number(hit.lon)
    if (!isValidLatLng(lat, lng)) return null
    return { lat, lng, label: hit.display_name ?? place, source: 'nominatim' }
  } catch (e) {
    if (e instanceof GeocodeError) throw e
    throw new GeocodeError(`The free geocoder (OpenStreetMap) could not be reached (${e instanceof Error ? e.message : String(e)}); try a ZIP code or "City, ST".`)
  } finally {
    clearTimeout(timer)
  }
}

/** Resolve a typed place to a point, or null when no free source knows it. */
export async function geocodePlace(db: Queryable, place: string, opts: GeocodeOptions = {}): Promise<GeoPoint | null> {
  if (typeof place !== 'string' || !place.trim()) throw new GeocodeError('place is required (a ZIP code, "City, ST", or an address)')
  if (place.length > MAX_PLACE_CHARS) throw new GeocodeError(`place is too long (max ${MAX_PLACE_CHARS} characters)`)
  const key = normalizePlace(place)

  const zip = ZIP_RE.exec(key)
  if (zip) return fromZip(db, zip[1]) // a ZIP is answered by the table alone, never guessed elsewhere

  const cached = await fromCache(db, key)
  if (cached !== undefined) return cached

  const cs = CITY_STATE_RE.exec(place.trim())
  if (cs) {
    const hit = await fromCityState(db, cs[1], cs[2])
    if (hit) {
      await toCache(db, key, hit, 'city_centroid')
      return hit
    }
  }

  if (opts.offline) return null
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const hit = await throttled(() => fromNominatim(place.trim(), fetchImpl))
  await toCache(db, key, hit, 'nominatim')
  return hit
}
