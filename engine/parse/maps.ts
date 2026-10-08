/**
 * Google Maps search results, as tapdash_scraper/scraper.py read them (stage
 * "maps"): the free tbm=map endpoint with a "pb" template, no API key.
 *
 * LEGAL NOTE: reading this endpoint directly is against Google's Terms of
 * Service. It is how the Oct 6 jeweler list was built (7 queries x the top-1000
 * US cities = 7,609 searches, 0 blocks at concurrency 6, about 17 minutes), and
 * it is one pluggable discovery source; the engine also takes a CSV/JSONL file
 * (e.g. an Overture Maps or OpenStreetMap export) instead.
 */

export interface MapsPlace {
  name: string
  website: string | null
  phone: string | null
  address: string | null
  categories: string[]
  lat: number | null
  lng: number | null
  city: string | null
  state: string | null
  rating: number | null
  reviews: number | null
  place_id: string | null
  cid: string | null
}

/** Fill the pb template for one query at one point (span in meters, page offset 0/20/40). */
export function buildPb(template: string, query: string, lat: number, lng: number, span: number, offset: number): string {
  let p = template.trim().replace('!1sdiamond store', '!1s' + query)
  p = p.replace(/!1d[\d.]+!2d-?[\d.]+!3d-?[\d.]+/, `!1d${span}!2d${lng}!3d${lat}`)
  if (offset) p = p.replace('!7i20', `!7i20!8i${offset}`)
  return p
}

export function mapsSearchUrl(template: string, query: string, lat: number, lng: number, offset: number): string {
  const params = new URLSearchParams({
    tbm: 'map', authuser: '0', hl: 'en', gl: 'us', q: query,
    pb: buildPb(template, query, lat, lng, 30000, offset),
  })
  return `https://www.google.com/search?${params.toString()}`
}

function g(a: unknown, ...idx: number[]): unknown {
  let cur: unknown = a
  for (const i of idx) {
    if (!Array.isArray(cur) || i >= cur.length) return null
    cur = cur[i]
  }
  return cur ?? null
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

function reviewsFromText(t: unknown): number | null {
  const m = /([\d,]+) review/.exec(String(t ?? ''))
  return m ? Number(m[1].replace(/,/g, '')) : null
}

/** The response body starts with a junk first line and carries a /*""*\/ marker. */
export function parseMapsBody(body: string): unknown {
  const nl = body.indexOf('\n')
  const raw = (nl >= 0 ? body.slice(nl + 1) : body).replace('/*""*/', '')
  return JSON.parse(raw)
}

/** Places from a parsed response (array index paths measured on the Oct 6 run). */
export function parsePlaces(j: unknown): MapsPlace[] {
  const out: MapsPlace[] = []
  const list = g(j, 64)
  if (!Array.isArray(list)) return out
  for (const e of list) {
    const p = g(e, 1)
    const name = str(g(p, 11))
    if (!p || !name) continue
    const cats = g(p, 13)
    out.push({
      name,
      website: str(g(p, 7, 0)),
      phone: str(g(p, 178, 0, 0)),
      address: str(g(p, 39)) ?? str(g(p, 18)),
      categories: Array.isArray(cats) ? cats.filter((c): c is string => typeof c === 'string') : [],
      lat: num(g(p, 9, 2)),
      lng: num(g(p, 9, 3)),
      city: str(g(p, 183, 1, 3)),
      state: str(g(p, 183, 1, 5)),
      rating: num(g(p, 4, 7)),
      reviews: num(g(p, 4, 8)) ?? reviewsFromText(g(p, 4, 3, 1)),
      place_id: str(g(p, 78)),
      cid: str(g(p, 10)),
    })
  }
  return out
}

/** True when Google answered with its "unusual traffic" page instead of results. */
export function isBlocked(status: number, finalUrl: string): boolean {
  return status === 429 || status === 503 || finalUrl.includes('/sorry/')
}

export function placeKey(p: Pick<MapsPlace, 'place_id' | 'cid' | 'name' | 'phone'>): string {
  return p.place_id || p.cid || `${p.name}|${p.phone ?? ''}`
}
