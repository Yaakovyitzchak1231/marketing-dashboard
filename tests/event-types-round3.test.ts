import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown, role: 'editor' as string | null, actor: 'owner' } }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }))
vi.mock('@/lib/auth/session', () => ({
  currentRole: async () => holder.role,
  currentActorId: async () => holder.actor,
  currentEmail: async () => null,
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error('NEXT_REDIRECT'), { to })
  },
}))
import { createTestDb } from './helpers/pglite-db'
import { registerEventType, updateEventType } from '@/lib/events/types-store'
import { registerEventTypeAction, updateEventTypeAction } from '@/app/actions/event-types'
import type { Queryable } from '@/lib/db/types'
type TestDb = Awaited<ReturnType<typeof createTestDb>>

const run = async (action: (f: FormData) => Promise<void>, fields: Record<string, string>) => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  const e = (await action(fd).catch((x) => x)) as { to?: string }
  return new URLSearchParams((e.to ?? '').split('?')[1] ?? '')
}

describe('event types round 3 (row 9, Kilo review)', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => db.close())

  it("an agent racing a person on a new key never overwrites the person's label", async () => {
    // The person's insert lands between the agent's (empty) select-for-update and its insert.
    let injected = false
    const racing: Queryable = {
      query: (async (sql: string, params?: unknown[]) => {
        if (!injected && /insert into lp\.event_types/.test(sql)) {
          injected = true
          await db.query(`insert into lp.event_types (key, label, category, source, created_by) values ('raced', 'Human label', 'custom', 'dashboard', 'owner')`)
        }
        return db.query(sql, params)
      }) as Queryable['query'],
    }
    await expect(registerEventType(racing, 'hermes', { key: 'raced', label: 'Agent label', category: 'signal' }, { canRelabel: false })).rejects.toMatchObject({ status: 409 })
    const { rows } = await db.query<{ label: string; category: string }>("select label, category from lp.event_types where key = 'raced'")
    expect(rows[0]).toEqual({ label: 'Human label', category: 'custom' })
  })

  it('a person in the same race relabels, with a Relabeled audit row, not a false Registered', async () => {
    let injected = false
    const racing: Queryable = {
      query: (async (sql: string, params?: unknown[]) => {
        if (!injected && /insert into lp\.event_types/.test(sql)) {
          injected = true
          await db.query(`insert into lp.event_types (key, label, category, source, created_by) values ('raced2', 'First', 'custom', 'dashboard', 'owner')`)
        }
        return db.query(sql, params)
      }) as Queryable['query'],
    }
    const r = await registerEventType(racing, 'owner', { key: 'raced2', label: 'Second', category: 'custom' })
    expect(r).toMatchObject({ label: 'Second', relabeled: true })
    const { rows } = await db.query<{ kind: string; summary: string }>("select kind, summary from lp.events where entity_type = 'event_type' and entity_id = 'raced2'")
    expect(rows.map((x) => x.summary)).toEqual(['Relabeled event type raced2 (Second)'])
  })

  it('updateEventType says unchanged when the patch changes nothing', async () => {
    await registerEventType(db, 'owner', { key: 'quiet', label: 'Quiet', category: 'custom' })
    const r = await updateEventType(db, 'owner', 'quiet', { label: 'Quiet', category: 'custom' })
    expect(r.unchanged).toBe(true)
  })

  it('banners match what happened: registered, unchanged, relabeled, no changes', async () => {
    holder.db = db
    holder.role = 'editor'
    holder.actor = 'owner'
    expect((await run(registerEventTypeAction, { key: 'banner_t', label: 'Banner', category: 'custom' })).get('saved')).toBe('Registered banner_t.')
    expect((await run(registerEventTypeAction, { key: 'banner_t', label: 'Banner', category: 'custom' })).get('saved')).toBe('banner_t is already registered exactly like that; nothing changed.')
    expect((await run(registerEventTypeAction, { key: 'banner_t', label: 'Banner 2', category: 'custom' })).get('saved')).toBe('Relabeled banner_t.')
    expect((await run(updateEventTypeAction, { key: 'banner_t', label: 'Banner 2', category: 'custom' })).get('saved')).toBe('No changes to banner_t.')
  })

  it('no database is an error banner, not a 500', async () => {
    holder.db = null
    const q = await run(registerEventTypeAction, { key: 'nodb', label: 'x', category: 'custom' })
    expect(q.get('error')).toMatch(/not connected/)
  })
})
