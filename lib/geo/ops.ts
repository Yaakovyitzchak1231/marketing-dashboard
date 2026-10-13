/**
 * Radius-search ops (TAP-171) for agents and the dashboard (POST /api/ops {op, ...};
 * lib/ops/dispatch.ts spreads these in).
 *
 *   geocode_place  {place}                                -> the point a place resolves to
 *   leads_near     {place | lat+lng, miles, limit?, offset?} -> leads within N miles, nearest first
 *   geo_status     {}                                     -> how many ZIPs are loaded, how many leads have a position
 *   geo_backfill   {after_id?, batch?}                    -> fill positions for existing leads, one batch
 *   geo_load_centroids {}                                 -> download GeoNames' free US ZIP file into lp.postal_centroids (owner)
 */
import type { Db } from '../db/types.ts'
import { OpsError } from '../ops/core.ts'
import { boundingBox, isValidLatLng, MAX_RADIUS_MILES } from './distance.ts'
import { geocodePlace, GeocodeError } from './geocode.ts'
import { loadUsCentroids } from './geonames.ts'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

function wrap(run: Op['run']): Op['run'] {
  return async (db, actor, a) => {
    try {
      return await run(db, actor, a)
    } catch (e) {
      if (e instanceof GeocodeError) throw new OpsError(e.message, 400)
      throw e
    }
  }
}

function miles(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0 || n > MAX_RADIUS_MILES) throw new OpsError(`miles must be a number above 0 and at most ${MAX_RADIUS_MILES}`)
  return n
}

function intArg(v: unknown, field: string, dflt: number, max: number): number {
  if (v == null) return dflt
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > max) throw new OpsError(`${field} must be an integer from 0 to ${max}`)
  return n
}

async function centre(db: Db, a: Args): Promise<{ lat: number; lng: number; label: string; source: string }> {
  if (a.lat != null || a.lng != null) {
    const lat = Number(a.lat)
    const lng = Number(a.lng)
    if (!isValidLatLng(lat, lng)) throw new OpsError('lat must be between -90 and 90 and lng between -180 and 180')
    return { lat, lng, label: `${lat.toFixed(4)}, ${lng.toFixed(4)}`, source: 'given' }
  }
  if (typeof a.place !== 'string' || !a.place.trim()) throw new OpsError('send place (a ZIP code, "City, ST" or an address) or lat + lng')
  const hit = await geocodePlace(db, a.place)
  if (!hit) throw new OpsError(`Couldn't find "${a.place}". Try a ZIP code or "City, ST".`, 404)
  return hit
}

export const GEO_OPS: Record<string, Op> = {
  geocode_place: {
    args: '{place}  -- a ZIP code, "City, ST" or an address; free sources only (ZIP table, then OpenStreetMap)',
    run: wrap(async (db, _actor, a) => {
      const hit = await geocodePlace(db, String(a.place ?? ''))
      return hit ? { found: true, ...hit } : { found: false, place: a.place }
    }),
  },
  leads_near: {
    args: '{place | lat+lng, miles, limit?, offset?}  -- leads within N miles, nearest first, with each distance',
    run: wrap(async (db, _actor, a) => {
      const c = await centre(db, a)
      const m = miles(a.miles)
      const limit = intArg(a.limit, 'limit', 50, 500)
      const offset = intArg(a.offset, 'offset', 0, 1_000_000)
      const box = boundingBox(c.lat, c.lng, m)
      const params: unknown[] = [c.lat, c.lng, m, box.minLat, box.maxLat]
      let lngSql = ''
      if (box.minLng != null && box.maxLng != null) {
        params.push(box.minLng, box.maxLng)
        lngSql = 'and g.longitude between $6::float8 and $7::float8'
      }
      const base = `from lp.company_geo g join lp.companies c on c.id = g.company_id
        where c.merged_into is null
          and g.latitude between $4::float8 and $5::float8 ${lngSql}
          and lp.miles_between($1::float8, $2::float8, g.latitude, g.longitude) <= $3::float8`
      const [{ rows: countRows }, { rows }] = await Promise.all([
        db.query<{ n: number }>(`select count(*)::int as n ${base}`, params),
        db.query<{ id: number; name: string | null; city: string | null; state: string | null; postal_code: string | null; geo_source: string; miles: number }>(
          `select c.id, c.name, c.city, c.state, c.postal_code, g.geo_source,
                  round(lp.miles_between($1::float8, $2::float8, g.latitude, g.longitude)::numeric, 1)::float8 as miles
           ${base}
           order by miles, c.id
           limit ${limit} offset ${offset}`,
          params,
        ),
      ])
      return {
        center: c,
        miles: m,
        total: countRows[0]?.n ?? 0,
        leads: rows,
        note: 'Distances are from each lead\'s ZIP-code centre (or city centre when it has no ZIP), so they are approximate. Leads with no usable ZIP or city are not counted -- geo_status says how many.',
      }
    }),
  },
  geo_status: {
    args: '{}  -- ZIP centroids loaded, and how many leads have a position (by source) or none',
    run: async (db) => {
      const [{ rows: zips }, { rows: bySource }, { rows: all }] = await Promise.all([
        db.query<{ country: string; n: number }>(`select country, count(*)::int as n from lp.postal_centroids group by country order by country`),
        db.query<{ geo_source: string; n: number }>(`select g.geo_source, count(*)::int as n from lp.company_geo g join lp.companies c on c.id = g.company_id where c.merged_into is null group by g.geo_source order by g.geo_source`),
        db.query<{ n: number }>(`select count(*)::int as n from lp.companies where merged_into is null`),
      ])
      const located = bySource.reduce((s, r) => s + r.n, 0)
      return {
        postal_centroids: zips,
        leads_total: all[0]?.n ?? 0,
        leads_with_position: located,
        leads_without_position: Math.max(0, (all[0]?.n ?? 0) - located),
        by_source: bySource,
      }
    },
  },
  geo_backfill: {
    args: '{after_id?, batch?}  -- fill positions for existing leads from the ZIP table, one batch (max 5000); repeat with the returned last_id until done',
    run: async (db, _actor, a) => {
      const after = a.after_id == null ? 0 : intArg(a.after_id, 'after_id', 0, Number.MAX_SAFE_INTEGER)
      const batch = intArg(a.batch, 'batch', 1000, 5000)
      const { rows } = await db.query<{ filled: number; scanned: number; last_id: number | null }>(
        `select filled, scanned, last_id from lp.company_geo_backfill($1::bigint, $2::int)`,
        [after, batch],
      )
      const r = rows[0] ?? { filled: 0, scanned: 0, last_id: null }
      return { filled: r.filled, scanned: r.scanned, last_id: r.last_id == null ? null : Number(r.last_id), done: r.scanned < batch }
    },
  },
  geo_load_centroids: {
    args: '{}  -- one-time setup: download the free GeoNames US ZIP-code file (~41k ZIPs, CC BY 4.0) into lp.postal_centroids; safe to re-run. Then run geo_backfill until done.',
    run: async (db) => {
      try {
        const r = await loadUsCentroids(db)
        return { loaded: r.rows, source: r.source, next: 'run geo_backfill {after_id: 0} and repeat with last_id until done=true' }
      } catch (e) {
        throw new OpsError(`Loading ZIP centroids failed: ${e instanceof Error ? e.message : String(e)}`, 502)
      }
    },
  },
}
