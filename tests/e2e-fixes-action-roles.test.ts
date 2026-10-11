import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'

// Found in the Phase 2 end-to-end test on real-size data (p2-e2e-report.md, S9):
// an editor could run owner-only server actions (merge, forget, retention) and
// every Phase 2 action wrote 'owner' into the audit log whoever was signed in.
const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown, role: null as string | null, actor: 'owner' } }))
vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db, dbConfigured: () => Boolean(holder.db) }))
vi.mock('@/lib/auth/session', () => ({
  currentRole: async () => holder.role,
  currentActorId: async () => holder.actor,
  currentEmail: async () => null,
}))

import { mergeAction } from '@/app/actions/merge'
import { forgetContactAction, setRetentionPolicyAction } from '@/app/actions/retention'
import { createSegmentAction, segmentFromTextAction } from '@/app/actions/segments'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
let db: TestDb
const as = (role: string | null, actor: string) => {
  holder.role = role
  holder.actor = actor
}

beforeAll(async () => {
  db = await createTestDb()
  holder.db = db
  await db.query(
    `insert into lp.actors (id, kind, display_name, email, role, active)
     values ('ed', 'human', 'Ed Itor', 'ed@example.com', 'editor', true)`,
  )
})
afterAll(async () => {
  holder.db = null
  await db.close()
})

describe('Phase 2 server actions check the role and record the real actor', () => {
  it('an editor cannot merge, forget or change retention; nothing changes', async () => {
    const a = await addCompany(db, { name: 'Gem A', state: 'NY' })
    const b = await addCompany(db, { name: 'Gem A dup', state: 'NY' })
    const { rows: ct } = await db.query<{ id: number }>(
      `insert into lp.contacts (company_id, email, email_norm, status) values ($1, 'x@gema.example', 'x@gema.example', 'new') returning id`,
      [a],
    )
    as('editor', 'ed')
    const m = await mergeAction({ entity: 'company', keep: a, merge: b })
    expect(m).toEqual({ ok: false, error: 'This needs owner access; you have editor access.' })
    const f = await forgetContactAction({ contact_id: ct[0].id, confirm: 'x@gema.example' })
    expect(f.ok).toBe(false)
    const r = await setRetentionPolicyAction({ event_category: 'email_opened', keep_days: 1 })
    expect(r.ok).toBe(false)

    const { rows: still } = await db.query<{ merged_into: number | null }>('select merged_into from lp.companies where id = $1', [b])
    expect(still[0].merged_into).toBeNull()
    const { rows: c } = await db.query<{ email: string | null }>('select email from lp.contacts where id = $1', [ct[0].id])
    expect(c[0].email).toBe('x@gema.example')
  })

  it('a viewer cannot spend AI credits on segment-from-text', async () => {
    as('viewer', 'viewer-1')
    expect(await segmentFromTextAction('jewelers in NY')).toEqual({ ok: false, error: 'This needs editor access; you have viewer access.' })
  })

  it('signed out is refused too', async () => {
    as(null, 'owner')
    const a = await addCompany(db, { name: 'Gem B', state: 'NJ' })
    const b = await addCompany(db, { name: 'Gem B dup', state: 'NJ' })
    expect(await mergeAction({ entity: 'company', keep: a, merge: b })).toEqual({ ok: false, error: 'Not signed in.' })
  })

  it('the owner can merge, and the audit log says owner', async () => {
    as('owner', 'owner')
    const a = await addCompany(db, { name: 'Gem C', state: 'CA' })
    const b = await addCompany(db, { name: 'Gem C dup', state: 'CA' })
    const m = await mergeAction({ entity: 'company', keep: a, merge: b })
    expect(m.ok).toBe(true)
    const { rows } = await db.query<{ actor: string }>('select actor from lp.merge_log where kept_id = $1', [a])
    expect(rows[0].actor).toBe('owner')
  })

  it("an editor can build a segment, and it's recorded as the editor, not 'owner'", async () => {
    as('editor', 'ed')
    const r = await createSegmentAction({
      name: 'NY stores',
      entity: 'company',
      definition: { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'is', value: 'NY' }] }] },
    })
    expect(r.ok).toBe(true)
    const { rows } = await db.query<{ created_by: string }>(`select created_by from lp.segments where name = 'NY stores'`)
    expect(rows[0].created_by).toBe('ed')
  })
})
