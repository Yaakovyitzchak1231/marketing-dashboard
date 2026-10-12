import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown, role: 'owner' as string | null, actor: 'owner' as string } }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }))
vi.mock('@/lib/auth/session', () => ({
  currentRole: async () => holder.role,
  currentActorId: async () => holder.actor,
  currentEmail: async () => null,
}))

import { GET as humanGet, POST as humanPost, PATCH as humanPatch } from '@/app/api/campaign-steps/[campaignId]/[[...path]]/route'

const req = (method: string, url: string, body?: unknown) => {
  const r = new Request(`http://x${url}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }) as Request & { nextUrl: URL }
  r.nextUrl = new URL(`http://x${url}`)
  return r
}
const ctx = (campaignId: number, path: string[] = []) => ({ params: Promise.resolve({ campaignId: String(campaignId), path }) })

describe('experiments over the human door: roles, transitions, outcome contract', () => {
  let db: TestDb
  let camp: number

  beforeEach(async () => {
    db = await createTestDb()
    holder.db = db
    holder.role = 'owner'
    holder.actor = 'owner'
    const { rows } = await db.query<{ id: number }>(`insert into lp.campaigns (name, pool) values ('C', 'jeweler') returning id`)
    camp = rows[0].id
    await db.tx(async (q) => {
      await q.query(`insert into lp.actors (id, kind, display_name, email, role, active) values ('eddie', 'human', 'Eddie', 'eddie@example.com', 'editor', true)`)
    }, 'owner')
  })
  afterEach(async () => db.close())

  const post = (path: string[], body: unknown) => humanPost(req('POST', `/x/${camp}/${path.join('/')}`, body), ctx(camp, path))
  const patch = (id: number, body: unknown) => humanPatch(req('PATCH', `/x/${camp}/experiments/${id}`, body), ctx(camp, ['experiments', String(id)]))
  async function createViaApi(step = 1, config?: unknown): Promise<number> {
    const res = await post(['experiments'], { step_number: step, name: 'Test', config })
    expect(res.status).toBe(201)
    return ((await res.json()) as { experiment: { id: number } }).experiment.id
  }
  const asEditor = () => { holder.role = 'editor'; holder.actor = 'eddie' }

  it('status changes (start, pause, decide) and evaluate need the owner: an editor gets 403 and nothing changes', async () => {
    const id = await createViaApi()
    asEditor()
    for (const body of [{ status: 'running' }, { status: 'paused' }, { status: 'decided', winner_variant: 'A' }]) {
      const res = await patch(id, body)
      expect(res.status, JSON.stringify(body)).toBe(403)
    }
    expect((await post(['experiments', String(id), 'evaluate'], {})).status).toBe(403)
    expect((await post(['experiments', String(id), 'outcome'], { variant: 'A', sends: 1 })).status).toBe(403)
    const { rows } = await db.query<{ status: string }>('select status from lp.experiments where id = $1', [id])
    expect(rows[0].status).toBe('draft')
    // config and name edits stay editor-level
    expect((await patch(id, { name: 'Renamed' })).status).toBe(200)
    expect((await patch(id, { config: { variants: [{ key: 'A', weight: 1 }, { key: 'B', weight: 2 }] } })).status).toBe(200)
    // the owner can move it, and the audit log names the owner
    holder.role = 'owner'
    holder.actor = 'owner'
    expect((await patch(id, { status: 'running' })).status).toBe(200)
  })

  it('enforces the transition table and the frozen config over the API', async () => {
    const id = await createViaApi()
    expect((await patch(id, { status: 'paused' })).status).toBe(409) // draft -> paused
    expect((await patch(id, { status: 'running' })).status).toBe(200)
    expect((await patch(id, { status: 'draft' })).status).toBe(409) // running -> draft
    expect((await patch(id, { config: { variants: [{ key: 'A', weight: 1 }, { key: 'B', weight: 1 }] } })).status).toBe(409)
    expect((await patch(id, { status: 'decided' })).status).toBe(400) // needs winner_variant
    const decided = await patch(id, { status: 'decided', winner_variant: 'B' })
    expect(decided.status).toBe(200)
    expect(((await decided.json()) as { experiment: { winner_variant: string } }).experiment.winner_variant).toBe('B')
    expect((await patch(id, { status: 'running' })).status).toBe(409)
  })

  it('refuses variant keys with a colon or space when creating an experiment (400)', async () => {
    for (const key of ['A:B', 'has space', '']) {
      const res = await post(['experiments'], { step_number: 1, name: 'Bad', config: { variants: [{ key, weight: 1 }, { key: 'B', weight: 1 }] } })
      expect(res.status, key).toBe(400)
    }
    const { rows } = await db.query<{ n: number }>('select count(*)::int as n from lp.experiments')
    expect(rows[0].n).toBe(0)
  })

  it('outcome: positive_replies is the field; replies is refused; bad variant 400; draft 409; non-numeric 400', async () => {
    const id = await createViaApi()
    const outcome = (body: unknown) => post(['experiments', String(id), 'outcome'], body)
    expect((await outcome({ variant: 'A', sends: 10 })).status).toBe(409) // still a draft
    await patch(id, { status: 'running' })
    const bad = await outcome({ variant: 'A', sends: 10, replies: 2 })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: string }).error).toMatch(/positive_replies/)
    expect((await outcome({ variant: 'Q', sends: 10 })).status).toBe(400)
    expect((await outcome({ variant: 'A', sends: 'abc' })).status).toBe(400)
    expect((await outcome({ variant: 'A', sends: 5, positive_replies: 6 })).status).toBe(400)
    const ok = await outcome({ variant: 'A', sends: 100, positive_replies: 7, idempotency_key: 'k1' })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toMatchObject({ ok: true, replayed: false, outcome: { variant: 'A', sends: 100, positive_replies: 7 } })
    const replay = await outcome({ variant: 'A', sends: 100, positive_replies: 7, idempotency_key: 'k1' })
    expect(await replay.json()).toMatchObject({ replayed: true, outcome: { sends: 100, positive_replies: 7 } })
    // replies-only follow-up
    expect((await outcome({ variant: 'A', positive_replies: 2 })).status).toBe(200)
  })

  it('assign: a suppressed lead comes back unassigned with a reason; GET detail still works', async () => {
    const id = await createViaApi()
    await patch(id, { status: 'running' })
    const co = await addCompany(db, { name: 'DNC', stage: 'do_not_contact' })
    const res = await post(['experiments', String(id), 'assign'], { company_id: co })
    expect(await res.json()).toMatchObject({ ok: true, assignment: { assigned: false, reason: 'do_not_contact' } })
    const missing = await post(['experiments', String(id), 'assign'], { company_id: 999999 })
    expect(missing.status).toBe(404)
    const detail = await humanGet(req('GET', `/x/${camp}/experiments/${id}`), ctx(camp, ['experiments', String(id)]))
    expect(detail.status).toBe(200)
  })
})
