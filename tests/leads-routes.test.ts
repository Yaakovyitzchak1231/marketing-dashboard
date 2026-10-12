import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
const { holder, kick } = vi.hoisted(() => ({ holder: { db: null as unknown }, kick: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }))
vi.mock('@/lib/auth/session', () => ({ currentRole: async () => 'owner', currentActorId: async () => 'owner', currentEmail: async () => null }))
vi.mock('@/lib/notify/kick', () => ({ kickDelivery: kick }))

import { PATCH } from '@/app/api/leads/stage/route'
import { POST } from '@/app/api/leads/[id]/comments/route'

const patch = (body: unknown) => PATCH(new Request('http://x/api/leads/stage', { method: 'PATCH', body: JSON.stringify(body) }))
const post = (id: string, body: unknown) =>
  POST(new Request(`http://x/api/leads/${id}/comments`, { method: 'POST', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })

describe('lead routes', () => {
  let db: TestDb
  let id: number
  beforeAll(async () => {
    db = await createTestDb()
    id = await addCompany(db, { name: 'Gem Co' })
  })
  afterAll(async () => {
    await db.close()
  })

  it('answer 503 with no database, never a fake success', async () => {
    holder.db = null
    expect((await patch({ company_ids: [1], stage: 'ready' })).status).toBe(503)
    expect((await post('1', { body: 'hi' })).status).toBe(503)
  })

  it('PATCH /api/leads/stage validates, updates as the owner, and reports counts', async () => {
    holder.db = db
    expect((await patch({ company_ids: [], stage: 'ready' })).status).toBe(400)
    expect((await patch({ company_ids: ['1'], stage: 'ready' })).status).toBe(400)
    expect((await patch({ company_ids: [id], stage: 'bogus' })).status).toBe(400)
    const res = await patch({ company_ids: [id], stage: 'ready' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ updated: 1, unchanged: 0, missing: 0 })
    const h = await db.query<{ changed_by: string }>(`select changed_by from lp.status_history where entity_id = $1 order by id desc limit 1`, [id])
    expect(h.rows[0].changed_by).toBe('owner')
  })

  it('POST /api/leads/:id/comments posts as the owner; 400 empty, 404 unknown lead', async () => {
    holder.db = db
    expect((await post(String(id), { body: '  ' })).status).toBe(400)
    expect((await post('999999', { body: 'hi' })).status).toBe(404)
    expect((await post('abc', { body: 'hi' })).status).toBe(404)
    const res = await post(String(id), { body: '@tab look at this one' })
    expect(res.status).toBe(201)
    const { comment } = (await res.json()) as { comment: { id: number; mentions: string[] } }
    expect(comment.mentions).toEqual(['tab'])
    expect(kick).toHaveBeenCalledTimes(1)
    expect(kick).toHaveBeenCalledWith(db)
    const c = await db.query<{ author: string }>(`select author from lp.comments where id = $1`, [comment.id])
    expect(c.rows[0].author).toBe('owner')
  })
})
