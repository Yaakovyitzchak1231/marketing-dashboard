/**
 * Let an agent (or the builder) write a radius condition with just the words --
 * {"kind":"radius","place":"Baltimore, MD","miles":25} -- and have the point filled
 * in before the definition is validated and stored. A saved definition always
 * carries lat/lng, so compiling a segment never calls a geocoder.
 */
import type { Queryable } from '../db/types.ts'
import { geocodePlace, GeocodeError, type GeocodeOptions } from './geocode.ts'

function isObj(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}

async function resolveGroups(db: Queryable, groups: unknown, opts: GeocodeOptions): Promise<unknown> {
  if (!Array.isArray(groups)) return groups
  const out: unknown[] = []
  for (const g of groups) {
    if (!isObj(g) || !Array.isArray(g.conditions)) {
      out.push(g)
      continue
    }
    const conds: unknown[] = []
    for (const c of g.conditions) {
      if (isObj(c) && c.kind === 'radius' && (c.lat == null || c.lng == null) && typeof c.place === 'string' && c.place.trim()) {
        const hit = await geocodePlace(db, c.place, opts)
        if (!hit) throw new GeocodeError(`Couldn't find "${c.place}". Try a ZIP code or "City, ST".`)
        conds.push({ ...c, lat: hit.lat, lng: hit.lng })
      } else {
        conds.push(c)
      }
    }
    out.push({ ...g, conditions: conds })
  }
  return out
}

/** Returns a copy of a raw (unvalidated) definition with place-only radius conditions resolved. */
export async function resolveRadiusPlaces(db: Queryable, raw: unknown, opts: GeocodeOptions = {}): Promise<unknown> {
  if (!isObj(raw)) return raw
  return { ...raw, include: await resolveGroups(db, raw.include, opts), exclude: await resolveGroups(db, raw.exclude, opts) }
}
