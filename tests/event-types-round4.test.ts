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
import { registerBanner, registerEventType } from '@/lib/events/types-store'
import { setEventTypeActiveAction } from '@/app/actions/event-types'
type TestDb = Awaited<ReturnType<typeof createTestDb>>

const run = async (action: (f: FormData) => Promise<void>, fields: Record<string, string>) => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  const e = (await action(fd).catch((x) => x)) as { to?: string }
  return new URLSearchParams((e.to ?? '').split('?')[1] ?? '')
}

describe('event types round 4 (PR #101 review: schema on relabel, deactivate confirm)', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => db.close())

  const stored = async (key: string) =>
    (await db.query<{ label: string; props_schema: unknown; active: boolean }>('select label, props_schema, active from lp.event_types where key = $1', [key])).rows[0]
  const audits = async (key: string) =>
    (await db.query<{ summary: string; data: Record<string, unknown> }>("select summary, data from lp.events where entity_type = 'event_type' and entity_id = $1 order by id", [key])).rows

  it('a person re-registering with a new props_schema persists it and reports it honestly', async () => {
    await registerEventType(db, 'owner', { key: 'sch_a', label: 'Schema A', category: 'custom', props_schema: { url: 'string' } })
    // Same label/category, new schema: not "unchanged", not a silent drop.
    const r = await registerEventType(db, 'owner', { key: 'sch_a', label: 'Schema A', category: 'custom', props_schema: { url: 'string', stars: 'number' } })
    expect(r.unchanged).toBeUndefined()
    expect(r.relabeled).toBeUndefined()
    expect(r.schema_updated).toBe(true)
    expect(r.props_schema).toEqual({ url: 'string', stars: 'number' })
    expect((await stored('sch_a')).props_schema).toEqual({ url: 'string', stars: 'number' })
    // Label and schema together: Relabeled, and the schema change named.
    const r2 = await registerEventType(db, 'owner', { key: 'sch_a', label: 'Schema A2', category: 'custom', props_schema: { url: 'string' } })
    expect(r2).toMatchObject({ relabeled: true, schema_updated: true, label: 'Schema A2', props_schema: { url: 'string' } })
    const a = await audits('sch_a')
    expect(a.map((x) => x.summary)).toEqual([
      'Registered event type sch_a (Schema A)',
      'Updated props_schema of event type sch_a',
      'Relabeled event type sch_a (Schema A2); props_schema updated',
    ])
    expect(a[1].data).toEqual({ props_schema: { from: { url: 'string' }, to: { url: 'string', stars: 'number' } } })
  })

  it('an omitted props_schema keeps the stored one; an explicit null clears it', async () => {
    await registerEventType(db, 'owner', { key: 'sch_b', label: 'Schema B', category: 'custom', props_schema: { a: 'string' } })
    const same = await registerEventType(db, 'owner', { key: 'sch_b', label: 'Schema B', category: 'custom' })
    expect(same.unchanged).toBe(true)
    const relabel = await registerEventType(db, 'owner', { key: 'sch_b', label: 'Schema B2', category: 'custom' })
    expect(relabel).toMatchObject({ relabeled: true, props_schema: { a: 'string' } })
    expect(relabel.schema_updated).toBeUndefined()
    expect((await stored('sch_b')).props_schema).toEqual({ a: 'string' })
    const cleared = await registerEventType(db, 'owner', { key: 'sch_b', label: 'Schema B2', category: 'custom', props_schema: null })
    expect(cleared).toMatchObject({ schema_updated: true, props_schema: null })
  })

  it('the register banner is honest for schema-only, relabel-only and relabel+schema re-registers', async () => {
    const b = async (input: { label: string; props_schema?: unknown }) =>
      registerBanner(await registerEventType(db, 'owner', { key: 'ban_s', category: 'custom', ...input }))
    expect(await b({ label: 'Ban', props_schema: { a: 'string' } })).toBe('Registered ban_s.')
    expect(await b({ label: 'Ban', props_schema: { a: 'string' } })).toBe('ban_s is already registered exactly like that; nothing changed.')
    // Schema-only: must NOT say "Registered".
    expect(await b({ label: 'Ban', props_schema: { a: 'number' } })).toBe('Updated props_schema of ban_s.')
    expect(await b({ label: 'Ban 2', props_schema: { a: 'number' } })).toBe('Relabeled ban_s.')
    // Both at once: names both.
    expect(await b({ label: 'Ban 3', props_schema: { a: 'string' } })).toBe('Relabeled ban_s and updated its props_schema.')
    expect((await stored('ban_s')).props_schema).toEqual({ a: 'string' })
  })

  it('an agent sending a different schema is still a 409 and writes nothing', async () => {
    await registerEventType(db, 'owner', { key: 'sch_c', label: 'Schema C', category: 'custom', props_schema: { a: 'string' } })
    await expect(registerEventType(db, 'hermes', { key: 'sch_c', label: 'Schema C', category: 'custom', props_schema: { a: 'number' } }, { canRelabel: false })).rejects.toMatchObject({ status: 409 })
    expect((await stored('sch_c')).props_schema).toEqual({ a: 'string' })
  })

  it('deactivating needs confirm=yes; activating does not', async () => {
    holder.db = db
    holder.role = 'editor'
    holder.actor = 'owner'
    await registerEventType(db, 'owner', { key: 'conf_t', label: 'Conf', category: 'custom' })
    const refused = await run(setEventTypeActiveAction, { key: 'conf_t', active: 'false' })
    expect(refused.get('error')).toMatch(/confirm/)
    expect((await stored('conf_t')).active).toBe(true)
    expect((await run(setEventTypeActiveAction, { key: 'conf_t', active: 'false', confirm: 'yes' })).get('saved')).toBe('Deactivated conf_t.')
    expect((await stored('conf_t')).active).toBe(false)
    expect((await run(setEventTypeActiveAction, { key: 'conf_t', active: 'true' })).get('saved')).toBe('Activated conf_t.')
    expect((await stored('conf_t')).active).toBe(true)
  })

  it('switching a type to the state it is already in says nothing changed and writes no audit row', async () => {
    await registerEventType(db, 'owner', { key: 'noop_t', label: 'Noop T', category: 'custom' })
    const before = (await audits('noop_t')).length
    expect((await run(setEventTypeActiveAction, { key: 'noop_t', active: 'true' })).get('saved')).toBe('noop_t was already active; nothing changed.')
    expect((await audits('noop_t')).length).toBe(before)
    await run(setEventTypeActiveAction, { key: 'noop_t', active: 'false', confirm: 'yes' })
    expect((await run(setEventTypeActiveAction, { key: 'noop_t', active: 'false', confirm: 'yes' })).get('saved')).toBe('noop_t was already inactive; nothing changed.')
    expect((await stored('noop_t')).active).toBe(false)
  })
})
