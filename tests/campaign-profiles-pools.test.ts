import { describe, it, expect, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { getOrCreatePool, listPools, PoolError } from '@/lib/pools/store'

// The wizard's pool picker reads and creates pools through lib/pools (the one pools module);
// these cover exactly the calls app/actions/campaign-profiles.ts makes.
describe('campaign-profile wizard pools (via lib/pools)', () => {
  it('lists the seeded pools by sort', async () => {
    const db = await createTestDb()
    try {
      const pools = await listPools(db)
      expect(pools.map((p) => p.id)).toEqual(['jeweler', 'ai_agency', 'ai_builder', 'other'])
    } finally {
      await db.close()
    }
  })

  it('"Create a new pool" adds one from a label, slugified, and a second click returns the same pool', async () => {
    const db = await createTestDb()
    try {
      const p = await getOrCreatePool(db, 'owner', { label: 'Restaurants' }, 'ui')
      expect(p.id).toBe('restaurants')
      expect(p.label).toBe('Restaurants')
      const again = await getOrCreatePool(db, 'owner', { label: 'Restaurants' }, 'ui')
      expect(again.id).toBe('restaurants')
      expect((await listPools(db)).map((x) => x.id)).toContain('restaurants')
    } finally {
      await db.close()
    }
  })

  it('rejects an empty label', async () => {
    const db = await createTestDb()
    try {
      await expect(getOrCreatePool(db, 'owner', { label: '   ' }, 'ui')).rejects.toThrow(PoolError)
    } finally {
      await db.close()
    }
  })
})
