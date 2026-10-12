import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'
import { EventTypeError, listEventTypesWithCounts, registerEventType, updateEventType } from '@/lib/events/types-store'
import { emitLeadEvent, EventError } from '@/lib/events/emit'
import { runOp } from '@/lib/ops/dispatch'
import { OpsError } from '@/lib/ops/core'
type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('event type registry core (lib/events/types-store)', () => {
  let db: TestDb
  let co: number
  beforeAll(async () => {
    db = await createTestDb()
    co = await addCompany(db, { name: 'Reg Co', domain: 'regco.example' })
  })
  afterAll(async () => db.close())

  it('registers a custom type with source dashboard and writes an audit row', async () => {
    const t = await registerEventType(db, 'owner', { key: 'demo_given', label: 'Demo given', category: 'meeting', source: 'dashboard' })
    expect(t).toMatchObject({ key: 'demo_given', source: 'dashboard', active: true, created_by: 'owner' })
    const { rows } = await db.query<{ kind: string }>("select kind from lp.events where entity_type = 'event_type' and entity_id = 'demo_given'")
    expect(rows.map((r) => r.kind)).toContain('event_type.registered')
  })

  it('rejects a bad slug, label or category', async () => {
    await expect(registerEventType(db, 'owner', { key: 'Bad Key', label: 'x', category: 'custom' })).rejects.toThrow(EventTypeError)
    await expect(registerEventType(db, 'owner', { key: 'ok_key', label: '', category: 'custom' })).rejects.toThrow(EventTypeError)
    await expect(registerEventType(db, 'owner', { key: 'ok_key', label: 'x', category: 'nope' })).rejects.toThrow(EventTypeError)
  })

  it('refuses to relabel a built-in type through register or update', async () => {
    await expect(registerEventType(db, 'owner', { key: 'email_sent', label: 'Hijacked', category: 'custom' })).rejects.toThrow(/built-in/)
    await expect(updateEventType(db, 'owner', 'email_sent', { active: false })).rejects.toThrow(/built-in/)
    const { rows } = await db.query<{ label: string; active: boolean }>("select label, active from lp.event_types where key = 'email_sent'")
    expect(rows[0]).toEqual({ label: 'Email sent', active: true })
  })

  it('updates label/category, deactivation makes emit refuse it, reactivation restores it', async () => {
    const u = await updateEventType(db, 'owner', 'demo_given', { label: 'Demo delivered', category: 'deal' })
    expect(u).toMatchObject({ key: 'demo_given', label: 'Demo delivered', category: 'deal' })
    await updateEventType(db, 'owner', 'demo_given', { active: false })
    await expect(emitLeadEvent(db, { type: 'demo_given', company_id: co, source: 'test' })).rejects.toThrow(EventError)
    await updateEventType(db, 'owner', 'demo_given', { active: true })
    await expect(emitLeadEvent(db, { type: 'demo_given', company_id: co, source: 'test' })).resolves.toMatchObject({ inserted: true })
    const { rows } = await db.query<{ summary: string }>("select summary from lp.events where kind = 'event_type.updated' and entity_id = 'demo_given' order by id")
    expect(rows.map((r) => r.summary)).toEqual(['Updated event type demo_given', 'Deactivated event type demo_given', 'Activated event type demo_given'])
  })

  it('an unknown key is a 404', async () => {
    await expect(updateEventType(db, 'owner', 'no_such', { active: false })).rejects.toMatchObject({ status: 404 })
  })

  it('lists every type with its stored lead_events count (0 for none)', async () => {
    const rows = await listEventTypesWithCounts(db)
    expect(rows.find((r) => r.key === 'demo_given')?.stored_count).toBe(1)
    expect(rows.find((r) => r.key === 'email_sent')?.stored_count).toBe(0)
  })

  it('update_event_type op maps errors to OpsError', async () => {
    await expect(runOp(db, 'owner', 'update_event_type', { key: 'email_sent', active: false })).rejects.toThrow(OpsError)
    const r = (await runOp(db, 'owner', 'update_event_type', { key: 'demo_given', label: 'Demo' })) as { label: string }
    expect(r.label).toBe('Demo')
  })
})
