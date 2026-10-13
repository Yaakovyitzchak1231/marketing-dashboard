/**
 * Load the free GeoNames postal-code file into lp.postal_centroids (TAP-171).
 *
 * Source: https://download.geonames.org/export/zip/US.zip (CC BY 4.0, no key).
 * The zip holds US.txt (tab-separated, ~41k rows) and a readme. We read the zip
 * ourselves with node:zlib so no new dependency is needed.
 *
 * Columns of US.txt: country, postal_code, place_name, admin1_name, admin1_code,
 * admin2_name, admin2_code, admin3_name, admin3_code, latitude, longitude, accuracy.
 */
import { inflateRawSync } from 'node:zlib'
import type { Queryable } from '../db/types.ts'
import { isValidLatLng } from './distance.ts'

export const GEONAMES_US_ZIP_URL = 'https://download.geonames.org/export/zip/US.zip'

export interface CentroidRow {
  country: string
  postal_code: string
  place_name: string | null
  admin1_code: string | null
  admin1_name: string | null
  latitude: number
  longitude: number
}

/** Pull one named file out of a zip archive (stored or deflated entries), via the central directory. */
export function unzipEntry(zip: Uint8Array, name: string): Buffer | null {
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength)
  // End of central directory: signature 0x06054b50, within the last 64 KB.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory record)')
  const entries = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < entries; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory')
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const entryName = buf.toString('utf8', p + 46, p + 46 + nameLen)
    if (entryName === name) {
      const lNameLen = buf.readUInt16LE(localOff + 26)
      const lExtraLen = buf.readUInt16LE(localOff + 28)
      const start = localOff + 30 + lNameLen + lExtraLen
      const data = buf.subarray(start, start + compSize)
      const bytes = new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.length)
      if (method === 0) return Buffer.from(bytes)
      if (method === 8) return inflateRawSync(bytes)
      throw new Error(`zip entry ${name} uses unsupported compression method ${method}`)
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  return null
}

/** Parse GeoNames' tab-separated postal file. Rows without a valid position are skipped. */
export function parseGeonamesPostal(text: string): CentroidRow[] {
  const out: CentroidRow[] = []
  const seen = new Set<string>()
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const f = line.split('\t')
    if (f.length < 11) continue
    const country = f[0].trim().toUpperCase()
    const postal = f[1].trim()
    const lat = Number(f[9])
    const lng = Number(f[10])
    if (!country || !postal || f[9].trim() === '' || f[10].trim() === '' || !isValidLatLng(lat, lng)) continue
    const key = `${country}|${postal}`
    if (seen.has(key)) continue // the primary key is (country, postal_code); keep the first
    seen.add(key)
    out.push({
      country,
      postal_code: postal,
      place_name: f[2].trim() || null,
      admin1_name: f[3].trim() || null,
      admin1_code: f[4].trim() || null,
      latitude: lat,
      longitude: lng,
    })
  }
  return out
}

/** Upsert rows in batches (unnest arrays: one round trip per batch). Returns rows written. */
export async function upsertCentroids(db: Queryable, rows: CentroidRow[], batch = 5000): Promise<number> {
  let written = 0
  for (let i = 0; i < rows.length; i += batch) {
    const b = rows.slice(i, i + batch)
    await db.query(
      `insert into lp.postal_centroids (country, postal_code, place_name, admin1_code, admin1_name, latitude, longitude)
       select * from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::float8[], $7::float8[])
       on conflict (country, postal_code) do update set place_name = excluded.place_name, admin1_code = excluded.admin1_code,
         admin1_name = excluded.admin1_name, latitude = excluded.latitude, longitude = excluded.longitude`,
      [
        b.map((r) => r.country), b.map((r) => r.postal_code), b.map((r) => r.place_name), b.map((r) => r.admin1_code),
        b.map((r) => r.admin1_name), b.map((r) => r.latitude), b.map((r) => r.longitude),
      ],
    )
    written += b.length
  }
  return written
}

/** Download GeoNames' US file and load it. ~2 MB download, ~41k rows. */
export async function loadUsCentroids(db: Queryable, fetchImpl: typeof fetch = fetch): Promise<{ rows: number; source: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30000)
  try {
    const res = await fetchImpl(GEONAMES_US_ZIP_URL, { signal: ctrl.signal, headers: { 'User-Agent': 'TapDash-marketing-dashboard/1.0 (radius search)' } })
    if (!res.ok) throw new Error(`GeoNames answered HTTP ${res.status} for ${GEONAMES_US_ZIP_URL}`)
    const zip = new Uint8Array(await res.arrayBuffer())
    const txt = unzipEntry(zip, 'US.txt')
    if (!txt) throw new Error('US.txt not found inside the GeoNames zip')
    const rows = parseGeonamesPostal(txt.toString('utf8'))
    if (rows.length < 1000) throw new Error(`GeoNames file looked wrong: only ${rows.length} usable rows`)
    return { rows: await upsertCentroids(db, rows), source: GEONAMES_US_ZIP_URL }
  } finally {
    clearTimeout(timer)
  }
}
