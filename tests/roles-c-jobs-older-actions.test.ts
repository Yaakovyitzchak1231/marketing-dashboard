import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'

// Viktor's re-review of #87 at 2000d9f (Medium): app/actions/jobs.ts had no
// role check, so an Editor could save an ops_call job with any op and press
// Run now, and the runner calls /api/ops with its own key. Job save, switch
// and run are now owner-only. (Low) The older actions now record the real
// signed-in person instead of a fixed 'owner'.
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

import { runJobNowAction, saveJobAction, toggleJobAction } from '@/app/actions/jobs'
import { addSuppressionAction } from '@/app/actions/suppressions'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
let db: TestDb
const as = (role: string | null, actor: string) => {
  holder.role = role
  holder.actor = actor
}
const form = (o: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(o)) f.set(k, v)
  return f
}
const count = async (sql: string, p: unknown[] = []) => (await db.query<{ n: number }>(sql, p)).rows[0].n

beforeAll(async () => {
  db = await createTestDb()
  holder.db = db
  await db.query(
    `insert into lp.actors (id, kind, display_name, email, role, active) values
       ('ed', 'human', 'Ed Itor', 'ed@example.com', 'editor', true),
       ('izzy', 'human', 'Izzy', 'izzy@example.com', 'owner', true)`,
  )
})
afterAll(async () => {
  holder.db = null
  await db.close()
})

describe('jobs are owner-only', () => {
  it('an editor cannot save an ops_call job, switch a job on, or run one now; nothing changes', async () => {
    as('editor', 'ed')
    const jobs0 = await count(`select count(*)::int as n from lp.jobs`)
    await expect(
      saveJobAction(form({ name: 'evil', kind: 'ops_call', payload: JSON.stringify({ op: 'forget_contact', args: { contact_id: 1 } }), enabled: 'on' })),
    ).rejects.toThrow(/REDIRECT:\/jobs\?error=This%20needs%20owner%20access/)
    expect(await count(`select count(*)::int as n from lp.jobs`)).toBe(jobs0)
    const { rows } = await db.query<{ name: string; enabled: boolean }>(`select name, enabled from lp.jobs order by name limit 1`)
    if (rows[0]) {
      await expect(toggleJobAction(form({ name: rows[0].name, enabled: String(!rows[0].enabled) }))).rejects.toThrow(/owner%20access/)
      await expect(runJobNowAction(form({ name: rows[0].name }))).rejects.toThrow(/owner%20access/)
      expect((await db.query<{ enabled: boolean }>(`select enabled from lp.jobs where name = $1`, [rows[0].name])).rows[0].enabled).toBe(rows[0].enabled)
    }
  })

  it('a viewer is refused too', async () => {
    as('viewer', 'ed')
    await expect(saveJobAction(form({ name: 'x', kind: 'ops_call' }))).rejects.toThrow(/owner%20access/)
  })
})

describe('older actions record the real person', () => {
  it('a suppression added by an editor is recorded as that editor, not owner', async () => {
    as('editor', 'ed')
    await expect(addSuppressionAction(form({ email: 'nope@example.com', reason: 'do_not_contact' }))).rejects.toThrow(/REDIRECT:\/suppressions\?saved=/)
    const r = await db.query<{ created_by: string }>(`select created_by from lp.suppressions where email_norm = 'nope@example.com'`)
    expect(r.rows[0]?.created_by).toBe('ed')
  })
})
