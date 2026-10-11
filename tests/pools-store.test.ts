import { describe, it, expect } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { createPool, getPool, listPools, PoolError, poolExists, slugifyPoolLabel, updatePool } from '@/lib/pools/store'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('pools store', () => {
  it('seeds the four original pools, active and sorted', async () => {
    const db: TestDb = await createTestDb()
    try {
      const pools = await listPools(db)
      expect(pools.map((p) => p.id)).toEqual(['jeweler', 'ai_agency', 'ai_builder', 'other'])
      expect(pools.every((p) => p.active)).toBe(true)
    } finally {
      await db.close()
    }
  })

  it('creates a brand-new pool from a label, slugified', async () => {
    const db: TestDb = await createTestDb()
    try {
      const p = await createPool(db, 'owner', { label: 'Dental Clinics' })
      expect(p.id).toBe('dental_clinics')
      expect(p.label).toBe('Dental Clinics')
      expect(await poolExists(db, 'dental_clinics')).toBe(true)
      expect(await getPool(db, 'dental_clinics')).toMatchObject({ id: 'dental_clinics', label: 'Dental Clinics' })
    } finally {
      await db.close()
    }
  })

  it('accepts an explicit id, refuses a bad one, refuses a duplicate', async () => {
    const db: TestDb = await createTestDb()
    try {
      const p = await createPool(db, 'owner', { id: 'restaurants', label: 'Restaurants' })
      expect(p.id).toBe('restaurants')
      await expect(createPool(db, 'owner', { id: 'Not Valid!', label: 'x' })).rejects.toThrow(PoolError)
      await expect(createPool(db, 'owner', { id: 'restaurants', label: 'Restaurants again' })).rejects.toThrow(/already exists/)
    } finally {
      await db.close()
    }
  })

  it('updates label/description/sort/active and writes one status_history row per changed field', async () => {
    const db: TestDb = await createTestDb()
    try {
      await createPool(db, 'owner', { id: 'dental_clinics', label: 'Dental' })
      const updated = await updatePool(db, 'dental_clinics', { label: 'Dental Clinics', sort: 50 }, 'owner', 'ui')
      expect(updated.label).toBe('Dental Clinics')
      expect(updated.sort).toBe(50)
      const { rows } = await db.query<{ field: string; entity_key: string; entity_id: number | null; via: string }>(
        `select field, entity_key, entity_id, via from lp.status_history where entity_type = 'pool' and entity_key = 'dental_clinics' order by changed_at`,
      )
      const fields = rows.map((r) => r.field)
      expect(fields).toContain('created')
      expect(fields).toContain('label')
      expect(fields).toContain('sort')
      expect(rows.every((r) => r.entity_id === null)).toBe(true)
      expect(rows.every((r) => r.entity_key === 'dental_clinics')).toBe(true)
    } finally {
      await db.close()
    }
  })

  it('updating an unknown pool fails clearly', async () => {
    const db: TestDb = await createTestDb()
    try {
      await expect(updatePool(db, 'nope', { label: 'x' })).rejects.toThrow(/No pool/)
    } finally {
      await db.close()
    }
  })

  it('slugifyPoolLabel makes a usable, bounded slug', () => {
    expect(slugifyPoolLabel('AI agencies')).toBe('ai_agencies')
    expect(slugifyPoolLabel('  Dental Clinics!! ')).toBe('dental_clinics')
  })

  it('includeInactive controls whether an inactive pool is listed', async () => {
    const db: TestDb = await createTestDb()
    try {
      await createPool(db, 'owner', { id: 'old_pool', label: 'Old pool', active: false })
      expect((await listPools(db)).map((p) => p.id)).not.toContain('old_pool')
      expect((await listPools(db, { includeInactive: true })).map((p) => p.id)).toContain('old_pool')
    } finally {
      await db.close()
    }
  })
})
