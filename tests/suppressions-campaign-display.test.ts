import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { createCampaign } from '@/lib/campaigns/store'
import { addLeadsByIds, getCampaignLead, listCampaignLeads } from '@/lib/campaigns/leads'
import { addSuppression } from '@/lib/suppressions/store'

describe('lib/campaigns/leads.ts: suppressed leads show as Parked — suppressed (reason)', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  let campaignId: number
  const co: Record<string, number> = {}
  beforeAll(async () => {
    db = await createTestDb()
    const c = await createCampaign(db, 'owner', { name: 'Display Test', pool: 'jeweler' })
    campaignId = c.id
    co.clean = await addCompany(db, { name: 'Clean Display Co' })
    await addContact(db, co.clean, 'clean@displaytest.com', 'valid')
    co.suppressed = await addCompany(db, { name: 'Suppressed Display Co' })
    await addContact(db, co.suppressed, 'blocked@displaytest.com', 'valid')
    await addLeadsByIds(db, 'owner', campaignId, [co.clean, co.suppressed])
    await addSuppression(db, 'owner', { email: 'blocked@displaytest.com', reason: 'competitor', campaign_id: campaignId })
  })
  afterAll(async () => db.close())

  it('listCampaignLeads marks the suppressed row and leaves the clean one alone', async () => {
    const { rows } = await listCampaignLeads(db, campaignId)
    const clean = rows.find((r) => r.company_id === co.clean)
    const blocked = rows.find((r) => r.company_id === co.suppressed)
    expect(clean?.suppressed).toBeNull()
    expect(blocked?.suppressed).toEqual({ reason: 'competitor' })
  })

  it('getCampaignLead carries the same suppressed field for one lead', async () => {
    const row = await getCampaignLead(db, campaignId, co.suppressed)
    expect(row?.suppressed).toEqual({ reason: 'competitor' })
    const clean = await getCampaignLead(db, campaignId, co.clean)
    expect(clean?.suppressed).toBeNull()
  })
})
