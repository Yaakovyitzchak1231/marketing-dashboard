/** Synthetic Google Maps tbm=map response shapes (index paths as the engine reads them). No real businesses. */
export interface FakePlace {
  name: string
  website?: string | null
  phone?: string | null
  address?: string | null
  categories?: string[]
  cid?: string | null
  place_id?: string | null
  reviews?: number | null
  rating?: number | null
}

export function mkPlace(o: FakePlace): unknown[] {
  const p: unknown[] = new Array(184).fill(null)
  p[11] = o.name
  p[7] = o.website ? [o.website] : null
  p[178] = o.phone ? [[o.phone]] : null
  p[39] = o.address ?? null
  p[13] = o.categories ?? []
  p[9] = [null, null, 39.4, -76.6]
  p[10] = o.cid ?? null
  p[78] = o.place_id ?? null
  const r: unknown[] = new Array(9).fill(null)
  r[7] = o.rating ?? null
  r[8] = o.reviews ?? null
  p[4] = r
  return p
}

export function mapsBody(places: unknown[][]): string {
  const j: unknown[] = new Array(65).fill(null)
  j[64] = places.map((p) => [null, p])
  return `)]}'\n/*""*/${JSON.stringify(j)}`
}
