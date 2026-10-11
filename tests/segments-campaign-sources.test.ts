import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { runOp } from '@/lib/ops/dispatch'
import { createCampaign } from '@/lib/campaigns/store'
import { parseCampaignPatch } from '@/lib/campaigns/types'
import { addSuppression } from '@/lib/suppressions/store'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function seg(db: TestDb, name: string, field: string, value: unknown, kind: 'static' | 'dynamic' = 'dynamic') {
  return (await runOp(db, 'tab', 'create_segment', {
    name,
    entity: 'company',
    kind,
    definition: kind === 'static' ? { entity: 'company', include: [] } : { entity: 'company', include: [{ conditions: [{ kind: 'field', field, op: 'is', value }] }] },
  })) as { id: number; name: string }
}

describe('campaign_add_from_segment (plan 2.6)', () => {
  let db: TestDb
  let campaignId: number
  let good: number

  beforeAll(async () => {
    db = await createTestDb()
    good = await addCompany(db, { name: 'Good Co', state: 'MD', stage: 'new' })
    await addCompany(db, { name: 'DNC Co', state: 'MD', stage: 'do_not_contact' })
    const suppressedCo = await addCompany(db, { name: 'Suppressed Co', state: 'MD', stage: 'new' })
    await addCompany(db, { name: 'Excluded Co', state: 'MD', stage: 'new' })
    await addContact(db, suppressedCo, 'blocked@suppressed.example', 'valid')
    await addSuppression(db, 'tab', { email: 'blocked@suppressed.example', reason: 'manual' })

    const c = await createCampaign(db, 'owner', parseCampaignPatch({ name: 'Source test', pool: 'jeweler' }, { create: true }) as { name: string })
    campaignId = c.id
  })
  afterAll(async () => {
    await db.close()
  })

  it('adds the eligible company, skips rule-rejected / suppressed / excluded, and persists the source', async () => {
    const source = await seg(db, 'MD leads', 'company.state', 'MD')
    const exclude = await seg(db, 'Excluded list', 'company.name', 'Excluded Co')

    const r = (await runOp(db, 'owner', 'campaign_add_from_segment', {
      campaign_id: campaignId,
      segment_id: source.id,
      exclude_segment_ids: [exclude.id],
      keep_syncing: true,
    })) as {
      matching: number; added: number; already: number
      skipped_by_rule: number; skipped_suppressed: number; skipped_excluded: number
    }

    expect(r.matching).toBe(4) // good, rejected, suppressed, excluded all have state MD
    expect(r.added).toBe(1)
    expect(r.skipped_by_rule).toBe(1)
    expect(r.skipped_suppressed).toBe(1)
    expect(r.skipped_excluded).toBe(1)

    const { rows: members } = await db.query<{ company_id: number }>('select company_id from lp.campaign_leads where campaign_id = $1', [campaignId])
    expect(members.map((m) => Number(m.company_id))).toEqual([good])

    const { rows: campRows } = await db.query<{ source_segment_id: number; source_sync: string; exclude_segment_ids: number[] }>(
      'select source_segment_id, source_sync, exclude_segment_ids from lp.campaigns where id = $1',
      [campaignId],
    )
    expect(Number(campRows[0].source_segment_id)).toBe(source.id)
    expect(campRows[0].source_sync).toBe('keep_syncing') // keep_syncing flag stored
    expect(campRows[0].exclude_segment_ids.map(Number)).toEqual([exclude.id])
  })

  it('a second run (keep syncing) adds nothing new -- idempotent', async () => {
    const source = (await runOp(db, 'owner', 'list_segments', {})) as { id: number; name: string }[]
    const mdSeg = source.find((s) => s.name === 'MD leads')!
    const exSeg = source.find((s) => s.name === 'Excluded list')!

    const r = (await runOp(db, 'owner', 'campaign_add_from_segment', {
      campaign_id: campaignId,
      segment_id: mdSeg.id,
      exclude_segment_ids: [exSeg.id],
    })) as { added: number; already: number }
    expect(r.added).toBe(0)
    expect(r.already).toBe(1)

    const { rows } = await db.query('select count(*)::int as n from lp.campaign_leads where campaign_id = $1', [campaignId])
    expect(Number((rows[0] as { n: number }).n)).toBe(1)
  })

  it('refuses an unknown campaign or segment', async () => {
    const source = await seg(db, 'Any', 'company.state', 'MD')
    await expect(runOp(db, 'owner', 'campaign_add_from_segment', { campaign_id: 999999, segment_id: source.id })).rejects.toMatchObject({ status: 404 })
    await expect(runOp(db, 'owner', 'campaign_add_from_segment', { campaign_id: campaignId, segment_id: 999999 })).rejects.toMatchObject({ status: 404 })
  })
})
