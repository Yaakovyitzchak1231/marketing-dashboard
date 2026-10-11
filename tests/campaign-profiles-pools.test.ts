import { describe, it, expect, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { createPool, listPools } from '@/lib/campaign-profiles/pools'
import { ProfileError } from '@/lib/campaign-profiles/store'

describe('pools (industries/audiences as rows, not a fixed list)', () => {
  it('lists the seeded pools by sort', async () => {
    const db = await createTestDb()
    try {
      const pools = await listPools(db)
      expect(pools.map((p) => p.id)).toEqual(['jeweler', 'ai_agency', 'ai_builder', 'other'])
    } finally {
      await db.close()
    }
  })

  it('createPool adds a new pool from a label, slugified, and is idempotent by id', async () => {
    const db = await createTestDb()
    try {
      const p = await createPool(db, 'owner', 'Restaurants')
      expect(p.id).toBe('restaurants')
      expect(p.label).toBe('Restaurants')
      const again = await createPool(db, 'owner', 'Restaurants')
      expect(again.id).toBe('restaurants')
      const pools = await listPools(db)
      expect(pools.map((x) => x.id)).toContain('restaurants')
    } finally {
      await db.close()
    }
  })

  it('rejects an empty label', async () => {
    const db = await createTestDb()
    try {
      await expect(createPool(db, 'owner', '   ')).rejects.toThrow(ProfileError)
    } finally {
      await db.close()
    }
  })
})
