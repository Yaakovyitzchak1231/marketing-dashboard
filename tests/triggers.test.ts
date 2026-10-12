import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'
import { emitLeadEvent } from '@/lib/events/emit'
import { editCompany } from '@/lib/leads/edit'
import { runOp } from '@/lib/ops/dispatch'
import { OpsError } from '@/lib/ops/core'
import { scanDueTriggers } from '@/lib/triggers/match'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function fires(db: TestDb, triggerId: number) {
  const { rows } = await db.query<{ company_id: number | null; payload: Record<string, unknown> }>(
    'select company_id, payload from lp.trigger_fires where trigger_id = $1 order by id',
    [triggerId],
  )
  return rows
}

describe('journey triggers (plan 3.2)', () => {
  let db: TestDb
  let co: number

  beforeAll(async () => {
    db = await createTestDb()
    co = await addCompany(db, { name: 'Gem Co', domain: 'gemco.example', city: 'Towson' })
  })
  afterAll(async () => db.close())

  it('fires an event trigger once, and skips a different type or campaign', async () => {
    const saved = await runOp(db, 'owner', 'upsert_trigger', {
      name: 'On custom', kind: 'event', config: { event_type: 'custom' },
    }) as { id: number }
    const other = await runOp(db, 'owner', 'upsert_trigger', {
      name: 'On reply', kind: 'event', config: { event_type: 'email_replied' },
    }) as { id: number }
    const { rows: camps } = await db.query<{ id: number }>(
      `insert into lp.campaigns (name) values ('Other campaign') returning id`,
    )
    const scoped = await runOp(db, 'owner', 'upsert_trigger', {
      name: 'Campaign only', kind: 'event', campaign_id: camps[0].id, config: { event_type: 'custom' },
    }) as { id: number }
    await emitLeadEvent(db, { type: 'custom', company_id: co, source: 'test' })
    await emitLeadEvent(db, { type: 'custom', company_id: co, source: 'test' })
    expect(await fires(db, saved.id)).toHaveLength(2)
    expect(await fires(db, other.id)).toHaveLength(0)
    expect(await fires(db, scoped.id)).toHaveLength(0)
  })

  it('segment entry fires on join, not twice, and exit fires when the scan sees them leave', async () => {
    const { rows } = await db.query<{ id: number }>(
      `insert into lp.segments (name, kind, entity, definition, created_by)
       values ('hand list', 'static', 'company', '{"entity":"company","include":[],"exclude":[]}', 'owner')
       returning id`,
    )
    const segmentId = rows[0].id
    const entry = await runOp(db, 'owner', 'upsert_trigger', {
      name: 'Entered list', kind: 'segment_entry', config: { segment_id: segmentId },
    }) as { id: number }
    const exit = await runOp(db, 'owner', 'upsert_trigger', {
      name: 'Left list', kind: 'segment_exit', config: { segment_id: segmentId },
    }) as { id: number }
    await runOp(db, 'owner', 'segment_add_members', { id: segmentId, company_ids: [co] })
    await runOp(db, 'owner', 'segment_add_members', { id: segmentId, company_ids: [co] })
    expect(await fires(db, entry.id)).toHaveLength(1)
    expect(await fires(db, exit.id)).toHaveLength(0)
    await db.query('delete from lp.segment_members where segment_id = $1 and company_id = $2', [segmentId, co])
    const scanned = await scanDueTriggers(db)
    expect(scanned.segment).toBeGreaterThanOrEqual(1)
    expect(await fires(db, exit.id)).toHaveLength(1)
    expect(await fires(db, entry.id)).toHaveLength(1)
  })

  it('fires a field_change trigger only when the value matches', async () => {
    const city = await runOp(db, 'owner', 'upsert_trigger', {
      name: 'City to Baltimore', kind: 'field_change', config: { entity: 'company', field: 'city', to: 'Baltimore' },
    }) as { id: number }
    await editCompany(db, co, { city: 'Pikesville' }, 'owner')
    expect(await fires(db, city.id)).toHaveLength(0)
    await editCompany(db, co, { city: 'Baltimore' }, 'owner')
    const rows = await fires(db, city.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].company_id).toBe(co)
  })

  it('a date trigger fires once per local day, a schedule trigger once per due slot', async () => {
    await db.query(`update lp.companies set last_researched_at = now() where id = $1`, [co])
    const date = await runOp(db, 'owner', 'upsert_trigger', {
      name: 'Researched today', kind: 'date',
      config: { entity: 'company', field: 'last_researched_at', offset_days: 0, timezone: 'UTC' },
    }) as { id: number }
    const schedule = await runOp(db, 'owner', 'upsert_trigger', {
      name: 'New year', kind: 'schedule', config: { cron: '0 0 1 1 *', timezone: 'UTC' },
    }) as { id: number }
    await db.query(`update lp.triggers set created_at = now() - interval '400 days' where id = $1`, [schedule.id])
    const first = await scanDueTriggers(db)
    expect(first.date).toBeGreaterThanOrEqual(1)
    expect(first.schedule).toBeGreaterThanOrEqual(1)
    expect(await fires(db, date.id)).toHaveLength(1)
    expect(await fires(db, schedule.id)).toHaveLength(1)
    await scanDueTriggers(db)
    expect(await fires(db, date.id)).toHaveLength(1)
    expect(await fires(db, schedule.id)).toHaveLength(1)
  })

  it('an API token fires, a bad token does not, and a repeat dedupe_key is a no-op', async () => {
    const saved = await runOp(db, 'owner', 'upsert_trigger', {
      name: 'Inbound', kind: 'api', config: {},
    }) as { id: number; token: string }
    expect(saved.token.startsWith('trg_')).toBe(true)
    const listed = await runOp(db, 'owner', 'list_triggers', {}) as { triggers: { id: number; has_token: boolean; token?: string }[] }
    const row = listed.triggers.find((t) => t.id === saved.id)
    expect(row?.has_token).toBe(true)
    expect(row?.token).toBeUndefined()
    const first = await runOp(db, 'hermes', 'fire_api_trigger', {
      token: saved.token, company_id: co, dedupe_key: 'once', payload: { source: 'form' },
    }) as { fired: boolean }
    const second = await runOp(db, 'hermes', 'fire_api_trigger', {
      token: saved.token, company_id: co, dedupe_key: 'once',
    }) as { fired: boolean }
    expect(first.fired).toBe(true)
    expect(second.fired).toBe(false)
    await expect(runOp(db, 'hermes', 'fire_api_trigger', { token: 'trg_nope', company_id: co })).rejects.toThrow(/unknown trigger token/)
  })

  it('a viewer cannot scan, and the runner can', async () => {
    await db.tx(async (q) => {
      await q.query(
        `insert into lp.actors (id, kind, display_name, harness, role) values ('viewer-test', 'human', 'Viewer', 'dashboard', 'viewer')`,
      )
    }, 'owner')
    await expect(runOp(db, 'viewer-test', 'scan_due_triggers', {})).rejects.toBeInstanceOf(OpsError)
    const scanned = await runOp(db, 'system', 'scan_due_triggers', {}) as { date: number }
    expect(scanned.date).toBeGreaterThanOrEqual(0)
  })
})
