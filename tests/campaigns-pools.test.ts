import { describe, it, expect } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { createCampaign, updateCampaign } from '@/lib/campaigns/store'
import { createPool } from '@/lib/pools/store'
import { CampaignError } from '@/lib/campaigns/types'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('campaigns + pools (campaign-agnostic)', () => {
  it('a newly inserted pool can be used by a new campaign', async () => {
    const db: TestDb = await createTestDb()
    try {
      await createPool(db, 'owner', { id: 'dental_clinics', label: 'Dental Clinics' })
      const c = await createCampaign(db, 'owner', { name: 'Dental pilot', pool: 'dental_clinics' })
      expect(c.pool).toBe('dental_clinics')
    } finally {
      await db.close()
    }
  })

  it('refuses an unknown pool on create, in plain words', async () => {
    const db: TestDb = await createTestDb()
    try {
      await expect(createCampaign(db, 'owner', { name: 'Bad pool', pool: 'not_a_real_pool' })).rejects.toThrow(/Unknown pool/)
    } finally {
      await db.close()
    }
  })

  it('refuses an unknown pool on update', async () => {
    const db: TestDb = await createTestDb()
    try {
      const c = await createCampaign(db, 'owner', { name: 'Fine', pool: 'jeweler' })
      await expect(updateCampaign(db, 'owner', c.id, { pool: 'nope' })).rejects.toThrow(CampaignError)
    } finally {
      await db.close()
    }
  })
})
