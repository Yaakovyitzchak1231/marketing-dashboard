import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { runOp } from '@/lib/ops/dispatch'
import { OP_MIN_ROLE } from '@/lib/ops/actor-role'
import { createCampaign } from '@/lib/campaigns/store'
import { parseCampaignPatch } from '@/lib/campaigns/types'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

// Hermes' review of #86: an ops key minted for a HUMAN actor could run Phase 2 write ops
// beyond that person's dashboard role. Agents (no role) keep working.
describe('review fix: /api/ops write ops respect a human key-holder\'s role', () => {
  let db: TestDb
  let campaignId: number
  beforeAll(async () => {
    db = await createTestDb()
    await db.query(`insert into lp.actors (id, kind, display_name, active, role, email) values
      ('vera', 'human', 'Vera', true, 'viewer', 'vera@example.com'),
      ('ed', 'human', 'Ed', true, 'editor', 'ed@example.com'),
      ('gone', 'human', 'Gone', false, 'editor', 'gone@example.com')
      on conflict do nothing`)
    await db.query(`insert into lp.actors (id, kind, display_name) values ('hermes', 'agent', 'Hermes') on conflict do nothing`)
    const c = await createCampaign(db, 'owner', parseCampaignPatch({ name: 'Roles', pool: 'jeweler' }, { create: true }) as { name: string })
    campaignId = c.id
  })
  afterAll(async () => { await db.close() })

  const status = async (actor: string, op: string, args: Record<string, unknown>) => {
    try {
      await runOp(db, actor, op, args)
      return 200
    } catch (e) {
      return (e as { status?: number }).status ?? 500
    }
  }

  it('a Viewer\'s key gets 403 on every gated write op (import_csv, recompute_scores, rename_tag, merge_tags, campaign_add_from_segment, ...)', async () => {
    for (const op of Object.keys(OP_MIN_ROLE)) {
      expect([op, await status('vera', op, {})]).toEqual([op, 403])
    }
    // A deactivated account is refused too.
    expect(await status('gone', 'create_segment', {})).toBe(403)
  })

  it('an Editor\'s key passes editor ops but not owner-only ones; an agent and the owner are unaffected', async () => {
    expect(await status('ed', 'rename_tag', { from: 'a', to: 'b' })).toBe(403)
    expect(await status('ed', 'recompute_scores', {})).toBe(403)
    const seg = (await runOp(db, 'ed', 'create_segment', { name: 'Ed seg', entity: 'company', definition: { entity: 'company', include: [] } })) as { id: number }
    expect(seg.id).toBeGreaterThan(0)
    expect(await status('ed', 'campaign_add_from_segment', { campaign_id: campaignId, segment_id: seg.id })).toBe(200)
    expect(await status('hermes', 'create_segment', { name: 'Hermes seg', entity: 'company', definition: { entity: 'company', include: [] } })).toBe(200)
    expect(await status('owner', 'rename_tag', { from: 'nope', to: 'other' })).not.toBe(403)
  })
})
