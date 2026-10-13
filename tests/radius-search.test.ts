import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { deflateRawSync } from 'node:zlib'

// The shared box is slow; PGlite boots a full Postgres per file.
vi.setConfig({ testTimeout: 120000, hookTimeout: 120000 })
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'
import { boundingBox, milesBetween, isValidLatLng } from '@/lib/geo/distance'
import { parseGeonamesPostal, unzipEntry, upsertCentroids } from '@/lib/geo/geonames'
import { geocodePlace } from '@/lib/geo/geocode'
import { validateDefinition } from '@/lib/segments/definition'
import { readback } from '@/lib/segments/readback'
import { runOp } from '@/lib/ops/dispatch'

// Real GeoNames rows (US.txt) for a few Baltimore-area ZIPs and one far away.
const SAMPLE = [
  'US\t21215\tBaltimore\tMaryland\tMD\tBaltimore (city)\t510\t\t\t39.3448\t-76.6834\t4',
  'US\t21093\tLutherville Timonium\tMaryland\tMD\tBaltimore\t005\t\t\t39.4384\t-76.6100\t4',
  'US\t21201\tBaltimore\tMaryland\tMD\tBaltimore (city)\t510\t\t\t39.2946\t-76.6252\t4',
  'US\t10001\tNew York\tNew York\tNY\tNew York\t061\t\t\t40.7484\t-73.9967\t4',
  'US\t99999\tBroken\tNowhere\tXX\t\t\t\t\t\t\t',
].join('\n')

const u8 = (b: Buffer): Uint8Array => new Uint8Array(b.buffer as ArrayBuffer, b.byteOffset, b.length)

function makeZip(name: string, content: string): Uint8Array {
  const data = Buffer.from(content, 'utf8')
  const comp = deflateRawSync(u8(data))
  const nameBuf = Buffer.from(name)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8)
  local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(8, 10)
  central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBuf.length, 28)
  central.writeUInt32LE(0, 42)
  const cdOffset = local.length + nameBuf.length + comp.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(central.length + nameBuf.length, 12); eocd.writeUInt32LE(cdOffset, 16)
  return u8(Buffer.concat([local, nameBuf, comp, central, nameBuf, eocd].map(u8)))
}

describe('radius search: pure helpers (TAP-171)', () => {
  it('measures great-circle miles', () => {
    // Baltimore 21215 -> NYC 10001 is ~172 miles as the crow flies.
    const d = milesBetween(39.3448, -76.6834, 40.7484, -73.9967)
    expect(d).toBeGreaterThan(165)
    expect(d).toBeLessThan(180)
    expect(milesBetween(39, -76, 39, -76)).toBe(0)
  })
  it('bounding box contains every point within the radius', () => {
    const box = boundingBox(39.3448, -76.6834, 25)
    expect(box.minLat).toBeLessThan(39.3448)
    expect(box.maxLat).toBeGreaterThan(39.3448)
    expect(box.minLng!).toBeLessThan(-76.6834)
    expect(box.maxLng!).toBeGreaterThan(-76.6834)
  })
  it('rejects bad coordinates', () => {
    expect(isValidLatLng(91, 0)).toBe(false)
    expect(isValidLatLng(0, 181)).toBe(false)
    expect(isValidLatLng(NaN, 0)).toBe(false)
    expect(isValidLatLng(39.3, -76.6)).toBe(true)
  })
  it('parses GeoNames rows and skips ones with no position', () => {
    const rows = parseGeonamesPostal(SAMPLE)
    expect(rows.map((r) => r.postal_code)).toEqual(['21215', '21093', '21201', '10001'])
    expect(rows[0]).toMatchObject({ country: 'US', place_name: 'Baltimore', admin1_code: 'MD', admin1_name: 'Maryland' })
  })
  it('reads a deflated entry out of a zip', () => {
    const zip = makeZip('US.txt', SAMPLE)
    expect(unzipEntry(zip, 'US.txt')!.toString('utf8')).toBe(SAMPLE)
    expect(unzipEntry(zip, 'readme.txt')).toBeNull()
  })
  it('validates a radius condition and reads it back in words', () => {
    const def = validateDefinition({ entity: 'company', include: [{ conditions: [{ kind: 'radius', lat: 39.3448, lng: -76.6834, miles: 25, place: 'Baltimore, MD' }] }] })
    expect(readback(def)).toContain('within 25 miles of Baltimore, MD')
    expect(() => validateDefinition({ entity: 'company', include: [{ conditions: [{ kind: 'radius', place: 'x', miles: 5 }] }] })).toThrow(/lat and lng are required/)
    expect(() => validateDefinition({ entity: 'company', include: [{ conditions: [{ kind: 'radius', lat: 39, lng: -76, miles: 0 }] }] })).toThrow(/miles/)
    expect(() => validateDefinition({ entity: 'company', include: [{ conditions: [{ kind: 'radius', lat: 39, lng: -76, miles: 9999 }] }] })).toThrow(/miles/)
  })
})

describe('radius search against Postgres (TAP-171)', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  let near: number, timonium: number, nyc: number, unknown: number

  beforeAll(async () => {
    db = await createTestDb()
    await upsertCentroids(db, parseGeonamesPostal(SAMPLE))
    near = await addCompany(db, { name: 'Downtown Jeweler', city: 'Baltimore', state: 'MD' })
    timonium = await addCompany(db, { name: 'Timonium Jeweler', city: 'Timonium', state: 'MD' })
    nyc = await addCompany(db, { name: 'NYC Jeweler', city: 'New York', state: 'NY' })
    unknown = await addCompany(db, { name: 'No Address Jeweler' })
    // ZIPs set after insert: the trigger must fill positions on update too ("2109" + leading zero loss is padded).
    await db.query(`update lp.companies set postal_code = '21201' where id = $1`, [near])
    await db.query(`update lp.companies set postal_code = '21093-1234' where id = $1`, [timonium])
  })
  afterAll(async () => { await db?.close() })

  it('fills positions from ZIP, then city+state; none for no address', async () => {
    const { rows } = await db.query<{ company_id: number; geo_source: string }>(`select company_id, geo_source from lp.company_geo order by company_id`)
    const by = new Map(rows.map((r) => [Number(r.company_id), r.geo_source]))
    expect(by.get(near)).toBe('postal_centroid')
    expect(by.get(timonium)).toBe('postal_centroid')
    expect(by.get(nyc)).toBe('city_centroid')
    expect(by.has(unknown)).toBe(false)
  })

  it('geocodes a ZIP and "City, ST" from the table without the network', async () => {
    const zip = await geocodePlace(db, '21215', { offline: true })
    expect(zip).toMatchObject({ source: 'postal_centroid' })
    const city = await geocodePlace(db, 'Baltimore, MD', { offline: true })
    expect(city?.source).toBe('city_centroid')
    expect(await geocodePlace(db, 'Somewhere Unknown', { offline: true })).toBeNull()
  })

  it('caches a Nominatim answer and never asks twice', async () => {
    let calls = 0
    const fetchImpl = async () => { calls++; return { ok: true, status: 200, json: async () => [{ lat: '39.4015', lon: '-76.6019', display_name: 'Towson Town Center' }] } }
    const a = await geocodePlace(db, 'Towson Town Center', { fetchImpl })
    const b = await geocodePlace(db, 'towson   town center', { fetchImpl })
    expect(a).toMatchObject({ source: 'nominatim', lat: 39.4015 })
    expect(b).toMatchObject({ lat: 39.4015 })
    expect(calls).toBe(1)
  })

  it('leads_near lists leads within N miles, nearest first', async () => {
    const r = (await runOp(db, 'system', 'leads_near', { place: '21215', miles: 15 })) as { total: number; leads: Array<{ id: number; miles: number }> }
    expect(new Set(r.leads.map((l) => Number(l.id)))).toEqual(new Set([near, timonium]))
    const ms = r.leads.map((l) => Number(l.miles))
    expect([...ms].sort((x, y) => x - y)).toEqual(ms)
    expect(r.total).toBe(2)
    const wide = (await runOp(db, 'system', 'leads_near', { place: '21215', miles: 200 })) as { total: number }
    expect(wide.total).toBe(3)
  })

  it('segment_preview resolves a place-only radius condition and counts matches', async () => {
    const r = (await runOp(db, 'system', 'segment_preview', {
      definition: { entity: 'company', include: [{ conditions: [{ kind: 'radius', place: 'Baltimore, MD', miles: 20 }] }] },
    })) as { counts: unknown; readback: string }
    expect(r.readback).toContain('within 20 miles of Baltimore, MD')
    expect(JSON.stringify(r.counts)).toMatch(/2/)
  })

  it('geo_status reports coverage', async () => {
    const s = (await runOp(db, 'system', 'geo_status', {})) as { leads_with_position: number; leads_without_position: number }
    expect(s.leads_with_position).toBe(3)
    expect(s.leads_without_position).toBe(1)
  })
})
