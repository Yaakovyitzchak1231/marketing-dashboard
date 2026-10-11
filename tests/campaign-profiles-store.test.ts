import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import {
  addItems, approvedItems, copyProfile, getProfile, setItemStatus, updateItem, upsertProfile, ProfileError,
} from '@/lib/campaign-profiles/store'
import { createCampaign } from '@/lib/campaigns/store'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('campaign profiles store (real Postgres via PGlite)', () => {
  let db: TestDb
  let restaurants: number
  let dental: number
  beforeAll(async () => {
    db = await createTestDb()
    restaurants = (await createCampaign(db, 'owner', { name: 'Restaurants Q4', pool: 'other' } as never)).id
    dental = (await createCampaign(db, 'owner', { name: 'Dental clinics', pool: 'other' } as never)).id
  })
  afterAll(async () => {
    await db.close()
  })

  it('getProfile creates nothing on read: an empty draft shape for a campaign with no row', async () => {
    const c = await createCampaign(db, 'owner', { name: 'No profile yet' } as never)
    const r = await getProfile(db, c.id)
    expect(r.exists).toBe(false)
    expect(r.profile).toMatchObject({ campaign_id: c.id, setup_status: 'draft', industry: null, icp: {}, kpis: [] })
    expect(Object.keys(r.items)).toEqual(
      expect.arrayContaining(['keyword', 'topic', 'competitor', 'feed', 'forum', 'directory', 'trade_show', 'signal_rule', 'fingerprint', 'social_channel', 'negative_keyword']),
    )
    for (const k of Object.keys(r.items)) expect(r.items[k as keyof typeof r.items]).toEqual([])
    const again = await db.query('select count(*)::int as n from lp.campaign_profiles where campaign_id = $1', [c.id])
    expect((again.rows[0] as { n: number }).n).toBe(0)
  })

  it('upsertProfile validates and creates the row on first write; is campaign-agnostic (any industry text)', async () => {
    const p = await upsertProfile(db, 'owner', restaurants, { industry: 'Restaurants', vertical: 'Fast casual', icp: { business_types: ['restaurant'], geographies: ['MD'] } })
    expect(p.industry).toBe('Restaurants')
    expect(p.icp.business_types).toEqual(['restaurant'])
    expect(p.setup_status).toBe('draft')
    const again = await getProfile(db, restaurants)
    expect(again.exists).toBe(true)
    expect(again.profile.vertical).toBe('Fast casual')
  })

  it('upsertProfile only writes changed fields and is a no-op when nothing changed', async () => {
    const before = await db.query('select count(*)::int as n from lp.status_history where entity_type = $1 and entity_id = $2', ['campaign_profile', restaurants])
    await upsertProfile(db, 'owner', restaurants, { industry: 'Restaurants' }) // unchanged
    const after = await db.query('select count(*)::int as n from lp.status_history where entity_type = $1 and entity_id = $2', ['campaign_profile', restaurants])
    expect((after.rows[0] as { n: number }).n).toBe((before.rows[0] as { n: number }).n)
    await upsertProfile(db, 'owner', restaurants, { value_prop: 'Fill empty tables fast' })
    const hist = await db.query<{ field: string }>('select field from lp.status_history where entity_type = $1 and entity_id = $2 order by id desc limit 1', ['campaign_profile', restaurants])
    expect(hist.rows[0].field).toBe('value_prop')
  })

  it('rejects unknown fields and bad values', async () => {
    await expect(upsertProfile(db, 'owner', restaurants, { bogus: 'x' } as never)).rejects.toThrow(ProfileError)
    await expect(upsertProfile(db, 'owner', restaurants, { setup_status: 'done' as never })).rejects.toThrow(/setup_status/)
    await expect(upsertProfile(db, 'owner', restaurants, { kpis: [{ metric: 'reply_rate' }] as never })).rejects.toThrow(/target/)
    await expect(upsertProfile(db, 'owner', 999999, { industry: 'x' })).rejects.toThrow(/No campaign/)
  })

  it('per-kind validation: feed/competitor URLs must be http(s); signal_rule type; fingerprint patterns', async () => {
    await expect(addItems(db, 'owner', restaurants, [{ kind: 'feed', name: 'Industry feed', value: 'ftp://nrn.com/feed' }])).rejects.toThrow(/http\(s\)/)
    await expect(addItems(db, 'owner', restaurants, [{ kind: 'competitor', name: 'Toast', config: { newsroom_url: 'not a url' } }])).rejects.toThrow(/http\(s\)/)
    await expect(addItems(db, 'owner', restaurants, [{ kind: 'signal_rule', name: 'Hiring GM', config: { type: 'made_up' } }])).rejects.toThrow(/signal_rule config.type/)
    await expect(addItems(db, 'owner', restaurants, [{ kind: 'fingerprint', name: 'Toast POS', config: { patterns: [] } }])).rejects.toThrow(/patterns/)
    const r = await addItems(db, 'owner', restaurants, [
      { kind: 'feed', name: 'Restaurant Dive', value: 'https://www.restaurantdive.com/feeds/news/' },
      { kind: 'competitor', name: 'Toast', value: 'toasttab.com', config: { newsroom_url: 'https://pos.toasttab.com/news' } },
      { kind: 'signal_rule', name: 'New GM hired', config: { type: 'hiring' } },
      { kind: 'fingerprint', name: 'Toast POS script', config: { patterns: ['toasttab.com/online-ordering'] } },
    ])
    expect(r.added).toHaveLength(4)
  })

  it('dedupes case-insensitively per kind, and reports already-existing items', async () => {
    const r1 = await addItems(db, 'owner', restaurants, [{ kind: 'keyword', name: 'farm to table' }])
    expect(r1.added).toHaveLength(1)
    const r2 = await addItems(db, 'owner', restaurants, [{ kind: 'keyword', name: 'Farm To Table' }, { kind: 'keyword', name: 'brunch menu' }])
    expect(r2.added.map((a) => a.name)).toEqual(['brunch menu'])
    expect(r2.already).toEqual([{ kind: 'keyword', name: 'Farm To Table' }])
    // different kind, same name: not a dupe
    const r3 = await addItems(db, 'owner', restaurants, [{ kind: 'topic', name: 'Farm To Table' }])
    expect(r3.added).toHaveLength(1)
  })

  it('new items default to status approved, source human unless given', async () => {
    const r = await addItems(db, 'owner', restaurants, [{ kind: 'topic', name: 'ghost kitchens' }])
    expect(r.added[0]).toMatchObject({ status: 'approved', source: 'human' })
  })

  it('setItemStatus: approve/reject/archive in batch, idempotent on same status, writes history', async () => {
    const r = await addItems(db, 'owner', restaurants, [{ kind: 'topic', name: 'ghost kitchens 2', status: 'suggested', source: 'ai', rationale: 'trending' }])
    const id = r.added[0].id
    const approved = await setItemStatus(db, 'owner', [id], 'approved')
    expect(approved[0].status).toBe('approved')
    const again = await setItemStatus(db, 'owner', [id], 'approved')
    expect(again[0].status).toBe('approved')
    const hist = await db.query<{ n: string }>(
      `select count(*)::text as n from lp.status_history where entity_type='campaign_profile' and field = $1 and old_value='suggested' and new_value='approved'`,
      [`item:topic:ghost kitchens 2`],
    )
    expect(Number(hist.rows[0].n)).toBe(1)
    await expect(setItemStatus(db, 'owner', [999999], 'approved')).rejects.toThrow(/No profile item/)
  })

  it('updateItem edits value/config with validation and rejects renaming onto a duplicate', async () => {
    const r = await addItems(db, 'owner', restaurants, [{ kind: 'topic', name: 'loyalty programs' }, { kind: 'topic', name: 'delivery apps' }])
    const [a, b] = r.added
    await expect(updateItem(db, 'owner', b.id, { name: a.name })).rejects.toThrow(/already exists/)
    const edited = await updateItem(db, 'owner', b.id, { value: 'doordash, ubereats' })
    expect(edited.value).toBe('doordash, ubereats')
  })

  it('approvedItems returns only approved, never suggested/rejected/archived', async () => {
    const r = await addItems(db, 'owner', restaurants, [
      { kind: 'forum', name: 'r/KitchenConfidential', status: 'suggested', source: 'ai' },
      { kind: 'forum', name: 'r/restaurateur', status: 'approved' },
      { kind: 'forum', name: 'r/foodservice', status: 'rejected' },
    ])
    const approved = await approvedItems(db, restaurants, 'forum')
    expect(approved.map((a) => a.name)).toEqual(['r/restaurateur'])
    const archived = r.added.find((a) => a.name === 'r/foodservice')!
    await setItemStatus(db, 'owner', [archived.id], 'archived')
    const stillApproved = await approvedItems(db, restaurants, 'forum')
    expect(stillApproved.map((a) => a.name)).toEqual(['r/restaurateur'])
  })

  it('copyProfile copies scalars and non-archived items with source copied, and dedupes against existing', async () => {
    await upsertProfile(db, 'owner', restaurants, { description: 'MD/VA sit-down restaurants', value_prop: 'More covers, less no-shows' })
    await addItems(db, 'owner', dental, [{ kind: 'keyword', name: 'farm to table' }]) // already exists on dest -> should not duplicate
    const r = await copyProfile(db, 'owner', restaurants, dental)
    expect(r.profile?.description).toBe('MD/VA sit-down restaurants')
    expect(r.items_copied).toBeGreaterThan(0)
    const destItems = await getProfile(db, dental)
    const farmToTable = destItems.items.keyword.filter((i) => i.name.toLowerCase() === 'farm to table')
    expect(farmToTable).toHaveLength(1) // not duplicated
    const copiedOnes = Object.values(destItems.items).flat().filter((i) => i.source === 'copied')
    expect(copiedOnes.length).toBeGreaterThan(0)
    await expect(copyProfile(db, 'owner', restaurants, restaurants)).rejects.toThrow(/must differ/)
    await expect(copyProfile(db, 'owner', restaurants, 999999)).rejects.toThrow(/must exist/)
  })

  it('every write records lp.status_history for campaign_profile with via', async () => {
    const { rows } = await db.query<{ via: string | null }>(
      `select via from lp.status_history where entity_type = 'campaign_profile' and entity_id = $1 order by id desc limit 1`,
      [restaurants],
    )
    expect(['ui', 'ops_api'].includes(rows[0].via ?? '')).toBe(true)
  })
})
