import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'

// Instinct's patch write-ups on #87 / #91 (Phase 2 review), applied by Viktor:
//  B  an Editor (or an agent key) may change a tag on at most EDITOR_TAG_CHANGE_CAP
//     leads at once; owners are not capped; merged-away rows are never counted or changed.
//  C  upsert_score_model / recompute_scores over ops: owner or the 'system' runner only.
//     set_tag_style over ops: owner only (agent keys were ungated).
//  A  (found by tests/server-actions-role-gate.test.ts) the campaigns actions now call
//     actorFor('editor') and write as the signed-in person instead of 'owner'.
const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown, role: null as string | null, actor: 'owner' } }))
vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`)
  },
}))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db, dbConfigured: () => Boolean(holder.db) }))
vi.mock('@/lib/auth/session', () => ({
  currentRole: async () => holder.role,
  currentActorId: async () => holder.actor,
  currentEmail: async () => null,
}))

import { changeTagAction, previewTagChangeAction } from '@/app/actions/tags'
import { createCampaignAction } from '@/app/actions/campaigns'
import { EDITOR_TAG_CHANGE_CAP, changeTagOnLeads, countLeadsWithAnyTag, previewTagChange, renameTag } from '@/lib/tags/store'
import { runOp } from '@/lib/ops/dispatch'
import { createCampaign } from '@/lib/campaigns/store'
import { parseCampaignPatch } from '@/lib/campaigns/types'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
let db: TestDb
let big: number[] = []
const as = (role: string | null, actor: string) => {
  holder.role = role
  holder.actor = actor
}
const form = (o: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(o)) f.set(k, v)
  return f
}
const redirectOf = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    const m = /^REDIRECT:(.*)$/.exec((e as Error).message)
    if (m) return new URL(m[1], 'http://x').searchParams
    throw e
  }
  throw new Error('expected a redirect')
}
const status = async (actor: string, op: string, args: Record<string, unknown>) => {
  try {
    await runOp(db, actor, op, args)
    return 200
  } catch (e) {
    return (e as { status?: number }).status ?? 500
  }
}
const tagged = async (tag: string) => (await db.query<{ n: number }>(`select count(*)::int as n from lp.companies where $1 = any(tags)`, [tag])).rows[0].n

beforeAll(async () => {
  db = await createTestDb()
  holder.db = db
  await db.tx((q) => q.query(`insert into lp.actors (id, kind, display_name, email, role, active) values
    ('ed', 'human', 'Ed', 'ed@example.com', 'editor', true),
    ('olive', 'human', 'Olive', 'olive@example.com', 'owner', true)
    on conflict do nothing`), 'owner')
  await db.query(`insert into lp.actors (id, kind, display_name) values ('hermes', 'agent', 'Hermes') on conflict do nothing`)
  // EDITOR_TAG_CHANGE_CAP + 1 leads tagged "bulk".
  const { rows } = await db.query<{ id: number }>(
    `insert into lp.companies (name, stage, segment, research_status, tags)
     select 'Bulk ' || g, 'new', 'jeweler', 'needs_research', array['bulk'] from generate_series(1, $1::int) g returning id`,
    [EDITOR_TAG_CHANGE_CAP + 1],
  )
  big = rows.map((r) => Number(r.id))
})
afterAll(async () => {
  holder.db = null
  await db.close()
})

describe('B: editor bulk-retag cap', () => {
  it(`an editor over ${EDITOR_TAG_CHANGE_CAP} leads is refused (403) and nothing changes; an owner may do it`, async () => {
    const n = big.length
    await expect(changeTagOnLeads(db, 'ed', { from: 'bulk', to: 'mass', company_ids: big, expected_count: n })).rejects.toMatchObject({ status: 403 })
    expect(await tagged('bulk')).toBe(n)
    const r = await changeTagOnLeads(db, 'olive', { from: 'bulk', to: 'mass', company_ids: big, expected_count: n }, { isOwner: true })
    expect(r.companies_updated).toBe(n)
    await changeTagOnLeads(db, 'olive', { from: 'mass', to: 'bulk', company_ids: big, expected_count: n }, { isOwner: true })
  })

  it(`an editor at exactly ${EDITOR_TAG_CHANGE_CAP} is allowed`, async () => {
    const some = big.slice(0, EDITOR_TAG_CHANGE_CAP)
    const r = await changeTagOnLeads(db, 'ed', { from: 'bulk', to: 'edge', company_ids: some, expected_count: some.length })
    expect(r.companies_updated).toBe(EDITOR_TAG_CHANGE_CAP)
    await changeTagOnLeads(db, 'olive', { from: 'edge', to: 'bulk', company_ids: some, expected_count: some.length }, { isOwner: true })
  })

  it('ops: an agent key over the cap gets 403; a human owner key does not', async () => {
    expect(await status('hermes', 'change_tag', { from: 'bulk', to: 'mass', company_ids: big, expected_count: big.length })).toBe(403)
    expect(await tagged('bulk')).toBe(big.length)
    expect(await status('olive', 'change_tag', { from: 'bulk', to: 'mass', company_ids: big, expected_count: big.length })).toBe(200)
    expect(await status('olive', 'change_tag', { from: 'mass', to: 'bulk', company_ids: big, expected_count: big.length })).toBe(200)
  })

  it('UI: an editor is refused at the preview step (no confirm for a change that would fail); an owner gets the confirm', async () => {
    as('editor', 'ed')
    const refused = await redirectOf(previewTagChangeAction(form({ from: 'bulk', to: 'mass', mode: 'selected', target: big.join(',') })))
    expect(refused.get('error')).toMatch(/need an owner/)
    expect(refused.get('confirm')).toBeNull()
    // A hand-crafted confirm post is refused too.
    const forced = await redirectOf(changeTagAction(form({ from: 'bulk', to: 'mass', mode: 'selected', target: big.join(','), expected_count: String(big.length) })))
    expect(forced.get('error')).toMatch(/need an owner/)
    expect(await tagged('bulk')).toBe(big.length)
    as('owner', 'olive')
    const step1 = await redirectOf(previewTagChangeAction(form({ from: 'bulk', to: 'mass', mode: 'selected', target: big.join(',') })))
    expect(step1.get('confirm')).toBe('change')
    expect(step1.get('count')).toBe(String(big.length))
  })

  it('merged-away leads are not counted, previewed or renamed', async () => {
    const keep = await addCompany(db, { name: 'Keeper' })
    const gone = await addCompany(db, { name: 'Merged away' })
    await db.query(`update lp.companies set tags = array['dup'] where id = any($1::bigint[])`, [[keep, gone]])
    await db.query(`update lp.companies set merged_into = $1 where id = $2`, [keep, gone])
    expect(await countLeadsWithAnyTag(db, ['dup'])).toBe(1)
    expect((await previewTagChange(db, { from: 'dup', company_ids: [keep, gone] })).count).toBe(1)
    const r = await renameTag(db, 'olive', { from: 'dup', to: 'single', expected_count: 1 })
    expect(r.companies_updated).toBe(1)
    const goneTags = (await db.query<{ tags: string[] }>(`select tags from lp.companies where id = $1`, [gone])).rows[0].tags
    expect(goneTags).toEqual(['dup'])
  })

  it('a single merged-away lead is "no company"', async () => {
    const keep = await addCompany(db, { name: 'Keeper 2' })
    const gone = await addCompany(db, { name: 'Merged away 2' })
    await db.query(`update lp.companies set tags = array['x'], merged_into = $1 where id = $2`, [keep, gone])
    await expect(changeTagOnLeads(db, 'ed', { from: 'x', to: 'y', company_id: gone })).rejects.toMatchObject({ status: 404 })
  })
})

describe('C: scoring and tag-style ops are owner (or system) only', () => {
  const model = { name: 'Agent model', entity: 'company', kind: 'engagement', rules: [{ rule_key: 'r', label: 'R', event_type: 'reply', points: 5 }] }

  it('an agent key gets 403 on upsert_score_model and recompute_scores, and no model is written', async () => {
    expect(await status('hermes', 'upsert_score_model', model)).toBe(403)
    expect(await status('hermes', 'recompute_scores', { summary: true })).toBe(403)
    const n = (await db.query<{ n: number }>(`select count(*)::int as n from lp.score_models where name = 'Agent model'`)).rows[0].n
    expect(n).toBe(0)
  })

  it('an editor key gets 403 too', async () => {
    expect(await status('ed', 'upsert_score_model', model)).toBe(403)
    expect(await status('ed', 'recompute_scores', {})).toBe(403)
  })

  it('system (the nightly score_refresh job) and a human owner can do both', async () => {
    expect(await status('system', 'recompute_scores', { summary: true })).toBe(200)
    // A per-campaign model, so it does not clash with the seeded default model (409).
    const c = await createCampaign(db, 'olive', parseCampaignPatch({ name: 'Scoring roles', pool: 'jeweler' }, { create: true }) as { name: string })
    expect(await status('olive', 'upsert_score_model', { ...model, name: 'Owner model', campaign_id: c.id })).toBe(200)
    expect(await status('olive', 'recompute_scores', { summary: true })).toBe(200)
  })

  it('reads stay open to an agent', async () => {
    expect(await status('hermes', 'list_score_models', {})).toBe(200)
  })

  it('set_tag_style: an agent key gets 403; the owner can', async () => {
    expect(await status('hermes', 'set_tag_style', { tag: 'bulk', colour: '#112233' })).toBe(403)
    expect(await status('olive', 'set_tag_style', { tag: 'bulk', colour: '#112233' })).toBe(200)
  })
})

describe('A: campaigns actions check the role', () => {
  it('createCampaignAction refuses a viewer before touching anything', async () => {
    as('viewer', 'vera')
    await expect(createCampaignAction(form({ name: 'Nope' }))).rejects.toThrow(/editor access/)
    as(null, 'nobody')
    await expect(createCampaignAction(form({ name: 'Nope' }))).rejects.toThrow()
  })

  it('an editor creates a campaign and the audit names the editor, not "owner"', async () => {
    as('editor', 'ed')
    await redirectOf(createCampaignAction(form({ name: 'Ed campaign', pool: 'jeweler' })))
    const { rows } = await db.query<{ created_by: string | null }>(`select created_by from lp.campaigns where name = 'Ed campaign'`)
    expect(rows).toEqual([{ created_by: 'ed' }])
  })
})
