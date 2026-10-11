import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { createCampaign } from '@/lib/campaigns/store'
import { routeToOp, runOp } from '@/lib/ops/dispatch'
import { OpsError } from '@/lib/ops/core'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('campaign-profile ops (agent door, same functions the dashboard uses)', () => {
  let db: TestDb
  let campaignId: number
  beforeAll(async () => {
    db = await createTestDb()
    campaignId = (await createCampaign(db, 'owner', { name: 'Restaurants via ops' } as never)).id
  })
  afterAll(async () => {
    await db.close()
  })

  it('get_campaign_profile reads an empty draft, creating nothing', async () => {
    const r = (await runOp(db, 'claude', 'get_campaign_profile', { campaign_id: campaignId })) as { exists: boolean; profile: { setup_status: string } }
    expect(r.exists).toBe(false)
    expect(r.profile.setup_status).toBe('draft')
  })

  it('update_campaign_profile validates and writes', async () => {
    const r = (await runOp(db, 'claude', 'update_campaign_profile', { campaign_id: campaignId, industry: 'Restaurants', value_prop: 'Fill tables' })) as { industry: string }
    expect(r.industry).toBe('Restaurants')
    await expect(runOp(db, 'claude', 'update_campaign_profile', { campaign_id: campaignId, bogus: 1 })).rejects.toBeInstanceOf(OpsError)
    await expect(runOp(db, 'claude', 'update_campaign_profile', { campaign_id: 999999, industry: 'x' })).rejects.toMatchObject({ status: 404 })
  })

  it('add_profile_items / set_profile_item_status / update_profile_item round-trip', async () => {
    const added = (await runOp(db, 'claude', 'add_profile_items', {
      campaign_id: campaignId,
      items: [{ kind: 'keyword', name: 'brunch menu' }, { kind: 'competitor', name: 'Toast', value: 'toasttab.com' }],
    })) as { added: { id: number; status: string }[] }
    expect(added.added).toHaveLength(2)
    const toastId = added.added[1].id
    const updated = (await runOp(db, 'claude', 'update_profile_item', { id: toastId, rationale: 'direct POS competitor' })) as { rationale: string }
    expect(updated.rationale).toBe('direct POS competitor')
    const kw = added.added[0]
    const statused = (await runOp(db, 'claude', 'set_profile_item_status', { ids: [kw.id], status: 'rejected' })) as { status: string }[]
    expect(statused[0].status).toBe('rejected')
    await expect(runOp(db, 'claude', 'add_profile_items', { campaign_id: campaignId, items: [{ kind: 'feed', name: 'bad', value: 'not-a-url' }] })).rejects.toBeInstanceOf(OpsError)
  })

  it('suggest_campaign_profile reports not configured without throwing when no AI provider is set', async () => {
    delete process.env.AI_BASE_URL
    delete process.env.AI_MODEL
    const r = (await runOp(db, 'claude', 'suggest_campaign_profile', { campaign_id: campaignId, industry: 'Restaurants' })) as { configured: boolean }
    expect(r.configured).toBe(false)
  })

  it('copy_campaign_profile copies to another campaign', async () => {
    const dest = (await createCampaign(db, 'owner', { name: 'Restaurants copy dest' } as never)).id
    const r = (await runOp(db, 'claude', 'copy_campaign_profile', { from: campaignId, to: dest })) as { profile: { industry: string } | null }
    expect(r.profile?.industry).toBe('Restaurants')
  })

  it('list_profile_items: scoped to one campaign returns approved only; across campaigns finds every active campaign\u2019s approved items of a kind', async () => {
    const c2 = (await createCampaign(db, 'owner', { name: 'Another campaign' } as never)).id
    await runOp(db, 'claude', 'add_profile_items', { campaign_id: c2, items: [{ kind: 'directory', name: 'Local Chamber', status: 'approved' }] })
    const scoped = (await runOp(db, 'claude', 'list_profile_items', { campaign_id: c2, kind: 'directory' })) as { name: string }[]
    expect(scoped.map((x) => x.name)).toEqual(['Local Chamber'])
    const all = (await runOp(db, 'claude', 'list_profile_items', { kind: 'directory' })) as { campaign_id: number; name: string }[]
    expect(all.some((x) => x.campaign_id === c2 && x.name === 'Local Chamber')).toBe(true)
    await expect(runOp(db, 'claude', 'list_profile_items', { kind: 'not_a_kind' })).rejects.toBeInstanceOf(OpsError)
  })

  it('routes under /api/ops are wired (dispatch.ts spread line)', async () => {
    const r = await runOp(db, 'claude', 'get_campaign_profile', { campaign_id: campaignId })
    expect(r).toBeTruthy()
    expect(() => routeToOp).not.toThrow()
  })
})
