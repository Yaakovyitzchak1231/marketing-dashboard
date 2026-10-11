import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'

// Yaakov's decision (Oct 11, 2026, 3:45 PM): a tag rename must NOT silently
// change the tag on every lead. Two explicit choices: one lead, or a group the
// user picks (selected leads / a segment) with a confirm step showing the
// count. Renaming everywhere is an owner-only choice with a confirm. ONE audit
// entry per action (who, old name, new name, count); no timeline row per lead.
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

import { changeTagAction, previewTagChangeAction, renameTagAction } from '@/app/actions/tags'
import { changeTagOnLeads, renameTag, TagError } from '@/lib/tags/store'
import { runOp } from '@/lib/ops/dispatch'
import { OpsError } from '@/lib/ops/core'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
let db: TestDb
let ids: number[] = []
const as = (role: string | null, actor: string) => {
  holder.role = role
  holder.actor = actor
}
const form = (o: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(o)) f.set(k, v)
  return f
}
const tagsOf = async (id: number) => (await db.query<{ tags: string[] }>(`select tags from lp.companies where id = $1`, [id])).rows[0].tags
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
const leadEvents = async () => (await db.query<{ n: number }>(`select count(*)::int as n from lp.lead_events where type in ('tag_added', 'tag_removed')`)).rows[0].n

beforeAll(async () => {
  db = await createTestDb()
  holder.db = db
  await db.query(`insert into lp.actors (id, kind, display_name, email, role, active) values ('ed', 'human', 'Ed', 'ed@example.com', 'editor', true)`)
  for (let i = 0; i < 5; i++) ids.push(await addCompany(db, { name: `Shop ${i}`, state: i < 3 ? 'NY' : 'NJ' }))
  await db.query(`update lp.companies set tags = array['hot', 'vip'] where id = any($1::bigint[])`, [ids])
  ids = ids.map(Number)
})
afterAll(async () => {
  holder.db = null
  await db.close()
})

describe('changing a tag is an explicit, counted choice', () => {
  it('(a) one lead: only that lead changes, one audit row, no timeline rows', async () => {
    const ev0 = await leadEvents()
    const r = await changeTagOnLeads(db, 'ed', { from: 'hot', to: 'priority', company_id: ids[0], via: 'ui' })
    expect(r.companies_updated).toBe(1)
    expect(await tagsOf(ids[0])).toEqual(['priority', 'vip'])
    expect(await tagsOf(ids[1])).toEqual(['hot', 'vip'])
    const h = await db.query<{ old_value: string; new_value: string; changed_by: string; note: string }>(
      `select old_value, new_value, changed_by, note from lp.status_history where entity_type = 'tag' and field = 'change'`,
    )
    expect(h.rows).toEqual([{ old_value: 'hot', new_value: 'priority', changed_by: 'ed', note: 'changed "hot" to "priority" on 1 lead (lead #' + ids[0] + ')' }])
    expect(await leadEvents()).toBe(ev0)
  })

  it('(b) a group needs the confirmed count; a stale count is refused and nothing changes', async () => {
    await expect(changeTagOnLeads(db, 'ed', { from: 'hot', to: 'priority', company_ids: [ids[1], ids[2]] })).rejects.toThrow(/Confirm the count/)
    await expect(changeTagOnLeads(db, 'ed', { from: 'hot', to: 'priority', company_ids: [ids[1], ids[2]], expected_count: 5 })).rejects.toBeInstanceOf(TagError)
    expect(await tagsOf(ids[1])).toEqual(['hot', 'vip'])
    const r = await changeTagOnLeads(db, 'ed', { from: 'hot', to: 'priority', company_ids: [ids[1], ids[2]], expected_count: 2 })
    expect(r.companies_updated).toBe(2)
    expect(await tagsOf(ids[3])).toEqual(['hot', 'vip'])
  })

  it('(b) a static-list segment changes only its members', async () => {
    const { rows } = await db.query<{ id: number }>(
      `insert into lp.segments (name, kind, entity) values ('Two NJ shops', 'static', 'company') returning id`,
    )
    const seg = Number(rows[0].id)
    await db.query(`insert into lp.segment_members (segment_id, company_id) values ($1, $2)`, [seg, ids[3]])
    const r = await changeTagOnLeads(db, 'ed', { from: 'vip', to: 'gold', segment_id: seg, expected_count: 1 })
    expect(r).toEqual({ companies_updated: 1, scope: 'segment "Two NJ shops"' })
    expect(await tagsOf(ids[3])).toEqual(['hot', 'gold'])
    expect(await tagsOf(ids[4])).toEqual(['hot', 'vip'])
  })

  it('UI: the group form shows a confirm step with the count first, then applies with that count', async () => {
    as('editor', 'ed')
    const step1 = await redirectOf(previewTagChangeAction(form({ from: 'vip', to: 'gold', mode: 'selected', target: `${ids[0]}, ${ids[1]}` })))
    expect(step1.get('confirm')).toBe('change')
    expect(step1.get('count')).toBe('2')
    expect(await tagsOf(ids[0])).toContain('vip') // nothing changed yet
    const step2 = await redirectOf(
      changeTagAction(form({ from: 'vip', to: 'gold', mode: 'selected', target: step1.get('target')!, expected_count: step1.get('count')! })),
    )
    expect(step2.get('saved')).toBe('Changed on 2 leads.')
    expect(await tagsOf(ids[0])).toEqual(['priority', 'gold'])
  })

  it('UI: rename everywhere is owner-only and confirms the count first', async () => {
    as('editor', 'ed')
    const refused = await redirectOf(renameTagAction(form({ from: 'hot', to: 'warm' })))
    expect(refused.get('error')).toBe('This needs owner access; you have editor access.')
    as('owner', 'owner')
    const step1 = await redirectOf(renameTagAction(form({ from: 'hot', to: 'warm' })))
    expect(step1.get('confirm')).toBe('rename')
    expect(step1.get('count')).toBe('2') // ids[3] and ids[4] still carry "hot"
    expect(await tagsOf(ids[4])).toContain('hot')
    const step2 = await redirectOf(renameTagAction(form({ from: 'hot', to: 'warm', expected_count: '2' })))
    expect(step2.get('saved')).toBe('Renamed on all 2 leads.')
    const h = await db.query<{ changed_by: string; note: string }>(`select changed_by, note from lp.status_history where entity_type = 'tag' and field = 'rename'`)
    expect(h.rows).toEqual([{ changed_by: 'owner', note: 'renamed "hot" to "warm" on all 2 leads' }])
  })

  it('ops: agents cannot rename or merge everywhere; change_tag previews, then needs the count', async () => {
    await expect(runOp(db, 'tab', 'rename_tag', { from: 'warm', to: 'cold', expected_count: 2 })).rejects.toMatchObject({ status: 403 })
    await expect(runOp(db, 'tab', 'merge_tags', { tags: ['warm'], into: 'cold', expected_count: 2 })).rejects.toBeInstanceOf(OpsError)
    await expect(renameTag(db, 'owner', { from: 'warm', to: 'cold', expected_count: undefined })).rejects.toThrow(/Confirm the count/)
    const pv = (await runOp(db, 'tab', 'change_tag', { from: 'warm', to: 'cold', company_ids: [ids[3], ids[4]], preview: true })) as { count: number }
    expect(pv.count).toBe(2)
    await expect(runOp(db, 'tab', 'change_tag', { from: 'warm', to: 'cold', company_ids: [ids[3], ids[4]] })).rejects.toMatchObject({ status: 409 })
    const done = (await runOp(db, 'tab', 'change_tag', { from: 'warm', to: 'cold', company_ids: [ids[3], ids[4]], expected_count: 2 })) as { companies_updated: number }
    expect(done.companies_updated).toBe(2)
    const owner = (await runOp(db, 'owner', 'rename_tag', { from: 'cold', to: 'frozen', expected_count: 2 })) as { companies_updated: number }
    expect(owner.companies_updated).toBe(2)
  })
})
