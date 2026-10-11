import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { getLeadProfile } from '@/lib/leads/profile'
import { addLeadFile, removeLeadFile, listLeadFiles } from '@/lib/leads/files'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function addCampaign(db: TestDb, name: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>(`insert into lp.campaigns (name) values ($1) returning id`, [name])
  return rows[0].id
}
async function addToCampaign(db: TestDb, campaignId: number, companyId: number): Promise<void> {
  await db.query(`insert into lp.campaign_leads (campaign_id, company_id) values ($1, $2)`, [campaignId, companyId])
}
async function addEvent(
  db: TestDb,
  t: { companyId: number; campaignId?: number | null; type: string; at: string },
): Promise<void> {
  await db.query(
    `insert into lp.lead_events (company_id, campaign_id, type, occurred_at, source) values ($1, $2, $3, $4, 'backfill')`,
    [t.companyId, t.campaignId ?? null, t.type, t.at],
  )
}

describe('getLeadProfile (plan 2.10, real Postgres via PGlite)', () => {
  let db: TestDb
  let geo: number
  let plain: number
  let campaignId: number

  beforeAll(async () => {
    db = await createTestDb()
    geo = await addCompany(db, { name: 'Geo Gems', state: 'MD', city: 'Baltimore' })
    plain = await addCompany(db, { name: 'Plain Co', state: 'NY', city: 'Albany' })
    await addContact(db, geo, 'owner@geogems.com', 'valid')
    await addContact(db, plain, 'hi@plain.co', 'unverified')

    campaignId = await addCampaign(db, 'Fall push')
    await addToCampaign(db, campaignId, geo)
    await addToCampaign(db, campaignId, plain)

    // geo: 2 sends, 2 opens, 1 reply. plain: 2 sends, 0 opens, 0 replies.
    await addEvent(db, { companyId: geo, campaignId, type: 'email_sent', at: '2026-10-01T09:00:00Z' })
    await addEvent(db, { companyId: geo, campaignId, type: 'email_opened', at: '2026-10-01T10:00:00Z' })
    await addEvent(db, { companyId: geo, campaignId, type: 'email_sent', at: '2026-10-03T09:00:00Z' })
    await addEvent(db, { companyId: geo, campaignId, type: 'email_opened', at: '2026-10-03T11:00:00Z' })
    await addEvent(db, { companyId: geo, campaignId, type: 'reply_received', at: '2026-10-03T12:00:00Z' })
    await addEvent(db, { companyId: plain, campaignId, type: 'email_sent', at: '2026-10-01T09:00:00Z' })
    await addEvent(db, { companyId: plain, campaignId, type: 'email_sent', at: '2026-10-03T09:00:00Z' })
  }, 30_000)
  afterAll(async () => {
    await db.close()
  })

  it('returns null for an id that does not exist', async () => {
    expect(await getLeadProfile(db, 999999)).toBeNull()
  })

  it('computes milestones exactly from lp.lead_events', async () => {
    const p = await getLeadProfile(db, geo)
    expect(p).not.toBeNull()
    expect(p!.milestones.first_touch).toBe('2026-10-01T09:00:00.000Z')
    expect(p!.milestones.first_open).toBe('2026-10-01T10:00:00.000Z')
    expect(p!.milestones.first_reply).toBe('2026-10-03T12:00:00.000Z')
    expect(p!.milestones.last_activity).toBe('2026-10-03T12:00:00.000Z')
  })

  it('a lead with no events yet has every milestone null, not a fabricated date', async () => {
    const empty = await addCompany(db, { name: 'Nothing Yet Co' })
    const p = await getLeadProfile(db, empty)
    expect(p!.milestones).toEqual({ first_touch: null, first_open: null, first_reply: null, last_activity: null })
  })

  it('reachability: verified email found, LinkedIn/owner phone not found when there is no such row', async () => {
    const p = await getLeadProfile(db, geo)
    const byKey = Object.fromEntries(p!.reachability.map((r) => [r.key, r]))
    expect(byKey.verified_email).toEqual({ key: 'verified_email', label: 'Verified email', value: 'owner@geogems.com', ok: true })
    expect(byKey.linkedin.ok).toBe(false)
    expect(byKey.linkedin.value).toBeNull()
  })

  it('campaigns card lists the campaign this lead was added to', async () => {
    const p = await getLeadProfile(db, geo)
    expect(p!.campaigns.available).toBe(true)
    expect(p!.campaigns.memberships).toHaveLength(1)
    expect(p!.campaigns.memberships[0]).toMatchObject({ campaign_id: campaignId, campaign_name: 'Fall push' })
  })

  it('engagement: this lead vs. the exact campaign average, from stored lp.lead_events rows only', async () => {
    const p = await getLeadProfile(db, geo)
    expect(p!.engagement.available).toBe(true)
    expect(p!.engagement.benchmarks).toHaveLength(1)
    const b = p!.engagement.benchmarks[0]
    expect(b.campaign_id).toBe(campaignId)
    // geo itself: 2 sends, 2 opens, 1 reply.
    expect(b.lead).toEqual({ opens: 2, replies: 1, steps: 2 })
    // campaign average across geo + plain (2 leads): sends (2+2)/2=2, opens (2+0)/2=1, replies (1+0)/2=0.5
    expect(b.campaign_average).toEqual({ steps: 2, opens: 1, replies: 0.5 })
  })

  it('a lead with no campaign events has an empty (not unavailable) engagement section', async () => {
    const lonely = await addCompany(db, { name: 'Lonely Co' })
    const p = await getLeadProfile(db, lonely)
    expect(p!.engagement).toEqual({ available: true, benchmarks: [] })
  })

  it('score section degrades gracefully: lp.scores does not exist on this base, so it is unavailable, not a crash', async () => {
    const p = await getLeadProfile(db, geo)
    expect(p!.score.available).toBe(false)
    expect(p!.score.row).toBeNull()
    expect(p!.score.needs_migration).toBeTruthy()
  })

  it('file links: add is audited, shows on the profile, remove is audited and clears it', async () => {
    const added = await addLeadFile(db, 'owner', { company_id: geo, name: 'Signed order form', url: 'https://drive.example.com/x' })
    expect(added.name).toBe('Signed order form')
    const p1 = await getLeadProfile(db, geo)
    expect(p1!.files.available).toBe(true)
    expect(p1!.files.rows.map((f) => f.name)).toContain('Signed order form')

    const { rows: addedAudit } = await db.query(
      `select * from lp.status_history where entity_type = 'file' and entity_id = $1 and field = 'added'`,
      [added.id],
    )
    expect(addedAudit).toHaveLength(1)

    const removed = await removeLeadFile(db, 'owner', added.id)
    expect(removed.removed).toBe(true)
    const after = await listLeadFiles(db, geo)
    expect(after.map((f) => f.id)).not.toContain(added.id)

    const { rows: removedAudit } = await db.query(
      `select * from lp.status_history where entity_type = 'file' and entity_id = $1 and field = 'removed'`,
      [added.id],
    )
    expect(removedAudit).toHaveLength(1)
  })

  it('segments card degrades gracefully when lp.segments is missing (simulating a preview DB before 0024)', async () => {
    const fresh = await createTestDb()
    try {
      await fresh.query('drop table lp.segment_members, lp.segments cascade')
      const co = await addCompany(fresh, { name: 'No Segments Yet' })
      const p = await getLeadProfile(fresh, co)
      expect(p!.segments).toEqual({ available: false, needs_migration: expect.stringContaining('0024'), memberships: [] })
    } finally {
      await fresh.close()
    }
  })

  it('files card degrades gracefully when lp.files is missing (simulating a preview DB before 0034)', async () => {
    const fresh = await createTestDb()
    try {
      await fresh.query('drop table lp.files cascade')
      const co = await addCompany(fresh, { name: 'No Files Yet' })
      const p = await getLeadProfile(fresh, co)
      expect(p!.files).toEqual({ available: false, needs_migration: expect.stringContaining('0034'), rows: [] })
    } finally {
      await fresh.close()
    }
  })
})
