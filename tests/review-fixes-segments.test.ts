import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'
import { runOp } from '@/lib/ops/dispatch'
import { createCampaign } from '@/lib/campaigns/store'
import { parseCampaignPatch } from '@/lib/campaigns/types'
import { addCompaniesToList } from '@/lib/segments/lists'
import { resolveAdvancedFilter } from '@/lib/leads/advanced'
import { compileSegment, compileStoredSegment, countSegment, matchingIds } from '@/lib/segments/compile'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

// Viktor's review of #77 / #85: static lists matched every company; exclude rules
// dropped NULL fields; exclusion segments were capped at 30,001 rows.
describe('review fixes: static lists, NULL-safe excludes, uncapped exclusions', () => {
  let db: TestDb
  let a: number, b: number, noState: number, ny: number
  let listId: number

  beforeAll(async () => {
    db = await createTestDb()
    a = await addCompany(db, { name: 'Alpha', state: 'MD' })
    b = await addCompany(db, { name: 'Beta', state: 'MD' })
    noState = await addCompany(db, { name: 'No State Co', state: null })
    ny = await addCompany(db, { name: 'NY Co', state: 'NY' })
    const r = await addCompaniesToList(db, 'owner', { newListName: 'Customers' }, [a])
    listId = r.list.id
  })
  afterAll(async () => { await db.close() })

  it('a static list matches only its members (counts, snapshot, ?seg=)', async () => {
    const seg = { id: listId, kind: 'static', entity: 'company', definition: { entity: 'company', include: [] } }
    const compiled = await compileStoredSegment(db, seg)
    expect(await matchingIds(db, compiled)).toEqual([a])
    expect((await countSegment(db, compiled)).companies).toBe(1)

    const adv = await resolveAdvancedFilter(db, listId, null)
    expect(adv.companyIds).toEqual([a])

    await runOp(db, 'tab', 'segment_snapshot', {})
    const { rows } = await db.query<{ companies: number }>(`select companies from lp.segment_snapshots where segment_id = $1`, [listId])
    expect(Number(rows[0].companies)).toBe(1)
  })

  it('in_segment / not_in_segment on a static list use its members', async () => {
    const inList = await compileSegment(db, { entity: 'company', include: [{ conditions: [{ kind: 'in_segment', segment_id: listId }] }] })
    expect(await matchingIds(db, inList)).toEqual([a])
    const notInList = await compileSegment(db, { entity: 'company', include: [{ conditions: [{ kind: 'not_in_segment', segment_id: listId }] }] })
    expect((await matchingIds(db, notInList)).sort((x, y) => x - y)).toEqual([b, noState, ny].sort((x, y) => x - y))
  })

  it('adding from a list adds only its members; excluding a list excludes only its members', async () => {
    const c1 = await createCampaign(db, 'owner', parseCampaignPatch({ name: 'From list', pool: 'jeweler' }, { create: true }) as { name: string })
    const r1 = (await runOp(db, 'owner', 'campaign_add_from_segment', { campaign_id: c1.id, segment_id: listId })) as { matching: number; added: number }
    expect(r1.matching).toBe(1)
    expect(r1.added).toBe(1)

    const md = (await runOp(db, 'tab', 'create_segment', {
      name: 'MD', entity: 'company',
      definition: { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'is', value: 'MD' }] }] },
    })) as { id: number }
    const c2 = await createCampaign(db, 'owner', parseCampaignPatch({ name: 'MD minus list', pool: 'jeweler' }, { create: true }) as { name: string })
    const r2 = (await runOp(db, 'owner', 'campaign_add_from_segment', { campaign_id: c2.id, segment_id: md.id, exclude_segment_ids: [listId] })) as { matching: number; added: number; skipped_excluded: number }
    expect(r2.matching).toBe(2)
    expect(r2.skipped_excluded).toBe(1)
    expect(r2.added).toBe(1)
  })

  it('an exclude rule keeps leads whose field is empty ("everyone except NY" keeps no-state leads)', async () => {
    const compiled = await compileSegment(db, {
      entity: 'company', include: [],
      exclude: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'is', value: 'NY' }] }],
    })
    const ids = await matchingIds(db, compiled)
    expect(ids).toContain(noState)
    expect(ids).not.toContain(ny)
    expect(ids.length).toBe(3)
  })

  it('an exclusion segment larger than 30,001 rows still excludes every one of its leads', async () => {
    // 30,001 filler rows first, so an un-ordered capped read would stop before the targets.
    await db.query(`insert into lp.companies (name, state, segment) select 'Filler ' || g, 'TX', 'jeweler' from generate_series(1, 30001) g`)
    const targets: number[] = []
    for (let i = 0; i < 3; i++) targets.push(await addCompany(db, { name: `Target ${i}`, state: 'TX', city: 'Target City' }))
    const tx = (await runOp(db, 'tab', 'create_segment', {
      name: 'All TX', entity: 'company',
      definition: { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'is', value: 'TX' }] }] },
    })) as { id: number }
    const src = (await runOp(db, 'tab', 'create_segment', {
      name: 'Target City', entity: 'company',
      definition: { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.city', op: 'is', value: 'Target City' }] }] },
    })) as { id: number }
    const c = await createCampaign(db, 'owner', parseCampaignPatch({ name: 'Big exclusion', pool: 'jeweler' }, { create: true }) as { name: string })
    const r = (await runOp(db, 'owner', 'campaign_add_from_segment', { campaign_id: c.id, segment_id: src.id, exclude_segment_ids: [tx.id] })) as { matching: number; added: number; skipped_excluded: number }
    expect(r.matching).toBe(3)
    expect(r.skipped_excluded).toBe(3)
    expect(r.added).toBe(0)
  }, 60_000)
})
