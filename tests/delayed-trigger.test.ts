import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { emitLeadEvent, emitLeadEvents } from '@/lib/events/emit'
import { runOp } from '@/lib/ops/dispatch'
import { scanDueTriggers, validateTriggerConfig, TriggerError } from '@/lib/triggers/match'
import { runDueJourneys } from '@/lib/journeys/runner'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('delayed trigger (plan 3.3)', () => {
  let db: TestDb
  let co: number

  beforeAll(async () => {
    db = await createTestDb()
    co = await addCompany(db, { name: 'Delay Co', domain: 'delay.example', city: 'Towson' })
  })
  afterAll(async () => db.close())

  it('fires N days after X, once, and not before the delay', async () => {
    const saved = await runOp(db, 'owner', 'upsert_trigger', {
      name: '3 days after sent unless replied',
      kind: 'delayed',
      config: { after_event: 'email_sent', days: 3, unless_event: 'reply_received' },
    }) as { id: number }
    await emitLeadEvent(db, { type: 'email_sent', company_id: co, source: 'test' })
    const early = await scanDueTriggers(db, new Date())
    expect(early.delayed).toBe(0)
    const later = await scanDueTriggers(db, new Date(Date.now() + 4 * 24 * 60 * 60 * 1000))
    expect(later.delayed).toBe(1)
    const again = await scanDueTriggers(db, new Date(Date.now() + 5 * 24 * 60 * 60 * 1000))
    expect(again.delayed).toBe(0)
    const { rows } = await db.query<{ payload: { cancel_on?: string[] } }>(
      'select payload from lp.trigger_fires where trigger_id = $1',
      [saved.id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].payload.cancel_on).toEqual(['reply_received'])
  })

  it('Y before the delay cancels the fire', async () => {
    const saved = await runOp(db, 'owner', 'upsert_trigger', {
      name: '2 days after click unless unsubscribed',
      kind: 'delayed',
      config: { after_event: 'email_link_clicked', days: 2, unless_events: ['lead_unsubscribed'] },
    }) as { id: number }
    await emitLeadEvent(db, { type: 'email_link_clicked', company_id: co, source: 'test' })
    await emitLeadEvent(db, { type: 'lead_unsubscribed', company_id: co, source: 'test' })
    const scanned = await scanDueTriggers(db, new Date(Date.now() + 3 * 24 * 60 * 60 * 1000))
    expect(scanned.delayed).toBe(0)
    const { rows } = await db.query<{ status: string }>(
      'select status from lp.trigger_delays where trigger_id = $1',
      [saved.id],
    )
    expect(rows.map((r) => r.status)).toEqual(['cancelled'])
  })

  it('enrols a live journey and copies cancel_on onto the run', async () => {
    const trigger = await runOp(db, 'owner', 'upsert_trigger', {
      name: '1 day after custom unless meeting',
      kind: 'delayed',
      config: { after_event: 'custom', days: 1, unless_event: 'meeting_booked' },
    }) as { id: number }
    const journey = await runOp(db, 'owner', 'journey_upsert', {
      name: 'After a day', trigger_id: trigger.id, entry_mode: 'once',
    }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', {
      journey_id: journey.id,
      graph: { start: 'n', nodes: [{ id: 'n', kind: 'note' }] },
    })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: journey.id, status: 'live' })
    await emitLeadEvent(db, { type: 'custom', company_id: co, source: 'test' })
    await scanDueTriggers(db, new Date(Date.now() + 2 * 24 * 60 * 60 * 1000))
    await runDueJourneys(db)
    const { rows } = await db.query<{ context: { cancel_on?: string[] } }>(
      'select context from lp.journey_runs where journey_id = $1',
      [journey.id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].context.cancel_on).toEqual(['meeting_booked'])
  })
})

const DAY = 24 * 60 * 60 * 1000
const ago = (days: number) => new Date(Date.now() - days * DAY)
const ahead = (days: number) => new Date(Date.now() + days * DAY)

describe('delayed trigger review fixes (plan 3.3)', () => {
  let db: TestDb
  let n = 0

  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => db.close())

  async function company(): Promise<number> {
    n++
    return addCompany(db, { name: `Fix Co ${n}`, domain: `fix${n}.example`, city: 'Towson' })
  }
  async function trigger(config: Record<string, unknown> = { after_event: 'email_sent', days: 3, unless_event: 'reply_received' }): Promise<number> {
    n++
    const saved = await runOp(db, 'owner', 'upsert_trigger', { name: `delayed ${n}`, kind: 'delayed', config }) as { id: number }
    return saved.id
  }
  async function delays(triggerId: number, companyId?: number) {
    const { rows } = await db.query<{ status: string; contact_id: number | null }>(
      `select status, contact_id from lp.trigger_delays
        where trigger_id = $1 and ($2::bigint is null or company_id = $2) order by id`,
      [triggerId, companyId ?? null],
    )
    return rows
  }
  async function fires(triggerId: number, companyId?: number): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      `select count(*) as n from lp.trigger_fires where trigger_id = $1 and ($2::bigint is null or company_id = $2)`,
      [triggerId, companyId ?? null],
    )
    return Number(rows[0].n)
  }

  it('1. a disabled trigger does not fire its pending delays; they are cancelled', async () => {
    const co = await company()
    const t = await trigger()
    await emitLeadEvent(db, { type: 'email_sent', company_id: co, source: 'test' })
    expect((await delays(t)).map((d) => d.status)).toEqual(['pending'])
    await runOp(db, 'owner', 'set_trigger_enabled', { id: t, enabled: false })
    await scanDueTriggers(db, ahead(4))
    expect(await fires(t)).toBe(0)
    expect((await delays(t)).map((d) => d.status)).toEqual(['cancelled'])
    // Re-enabling does not resurrect it.
    await runOp(db, 'owner', 'set_trigger_enabled', { id: t, enabled: true })
    await scanDueTriggers(db, ahead(5))
    expect(await fires(t)).toBe(0)
  })

  it('1b. disable then re-enable with no scan in between still cancels the delays (set_trigger_enabled and upsert_trigger)', async () => {
    const co = await company()
    const t = await trigger()
    await emitLeadEvent(db, { type: 'email_sent', company_id: co, source: 'test' })
    await runOp(db, 'owner', 'set_trigger_enabled', { id: t, enabled: false })
    expect((await delays(t)).map((d) => d.status)).toEqual(['cancelled'])
    await runOp(db, 'owner', 'set_trigger_enabled', { id: t, enabled: true })
    await scanDueTriggers(db, ahead(4))
    expect(await fires(t)).toBe(0)
    expect((await delays(t)).map((d) => d.status)).toEqual(['cancelled'])

    // Same through upsert_trigger { enabled: false }, then upsert back on.
    const co2 = await company()
    const cfg = { after_event: 'email_sent', days: 3, unless_event: 'reply_received' }
    const t2 = await trigger(cfg)
    await emitLeadEvent(db, { type: 'email_sent', company_id: co2, source: 'test' })
    await runOp(db, 'owner', 'upsert_trigger', { id: t2, name: 'renamed off', kind: 'delayed', config: cfg, enabled: false })
    await runOp(db, 'owner', 'upsert_trigger', { id: t2, name: 'renamed on', kind: 'delayed', config: cfg, enabled: true })
    await scanDueTriggers(db, ahead(4))
    expect(await fires(t2, co2)).toBe(0)
    expect((await delays(t2, co2)).map((d) => d.status)).toEqual(['cancelled'])

    // A delay armed after re-enabling is live again.
    const co3 = await company()
    await emitLeadEvent(db, { type: 'email_sent', company_id: co3, source: 'test' })
    await scanDueTriggers(db, ahead(4))
    expect(await fires(t2, co3)).toBe(1)
  })

  it('2. a Y that occurred after due_at does not cancel an owed fire', async () => {
    const co = await company()
    const t = await trigger()
    await emitLeadEvent(db, { type: 'email_sent', company_id: co, source: 'test' })
    // Recorded late (scan backlog): it happened 5 days from now, the delay is 3 days.
    await emitLeadEvent(db, { type: 'reply_received', company_id: co, source: 'test', occurred_at: ahead(5) })
    expect((await delays(t)).map((d) => d.status)).toEqual(['pending'])
    await scanDueTriggers(db, ahead(6))
    expect(await fires(t, co)).toBe(1)
    expect((await delays(t)).map((d) => d.status)).toEqual(['fired'])
  })

  it('3. the Y window starts at the source event time, not when the delay row was written', async () => {
    const co = await company()
    const t = await trigger({ after_event: 'email_sent', days: 30, unless_event: 'reply_received' })
    // Y is stored first (no delay exists yet), then the older X is backfilled.
    await emitLeadEvent(db, { type: 'reply_received', company_id: co, source: 'test', occurred_at: ago(8) })
    await emitLeadEvent(db, { type: 'email_sent', company_id: co, source: 'test', occurred_at: ago(10) })
    const { rows } = await db.query<{ ok: boolean }>(
      `select d.source_at = le.occurred_at as ok
         from lp.trigger_delays d join lp.lead_events le on le.id = d.source_event_id
        where d.trigger_id = $1`,
      [t],
    )
    expect(rows).toEqual([{ ok: true }])
    await scanDueTriggers(db, ahead(21))
    expect(await fires(t, co)).toBe(0)
    expect((await delays(t)).map((d) => d.status)).toEqual(['cancelled'])
  })

  it('4. emit-time cancel leaves past-due rows to the scan, which applies the window', async () => {
    const co = await company()
    const t = await trigger()
    // Backfilled X from 10 days ago: due 7 days ago.
    await emitLeadEvent(db, { type: 'email_sent', company_id: co, source: 'test', occurred_at: ago(10) })
    // Y that happened inside the window (8 days ago), stored now: the row is past due, so emit leaves it.
    await emitLeadEvent(db, { type: 'reply_received', company_id: co, source: 'test', occurred_at: ago(8) })
    expect((await delays(t)).map((d) => d.status)).toEqual(['pending'])
    await scanDueTriggers(db)
    expect(await fires(t, co)).toBe(0)
    expect((await delays(t)).map((d) => d.status)).toEqual(['cancelled'])

    // Same shape, but the Y happened after due_at (today): the fire is owed.
    const co2 = await company()
    await emitLeadEvent(db, { type: 'email_sent', company_id: co2, source: 'test', occurred_at: ago(10) })
    await emitLeadEvent(db, { type: 'reply_received', company_id: co2, source: 'test' })
    expect((await delays(t, co2)).map((d) => d.status)).toEqual(['pending'])
    await scanDueTriggers(db)
    expect(await fires(t, co2)).toBe(1)
  })

  it('5. a batch is processed in order: arm then cancel per event', async () => {
    const t = await trigger()
    const base = Date.now() - 60 * 60 * 1000
    const at = (ms: number) => new Date(base + ms)

    // [X, Y]: Y answers the X before it in the batch.
    const a = await company()
    await emitLeadEvents(db, [
      { type: 'email_sent', company_id: a, source: 'test', occurred_at: at(0) },
      { type: 'reply_received', company_id: a, source: 'test', occurred_at: at(1000) },
    ])
    expect((await delays(t, a)).map((d) => d.status)).toEqual(['cancelled'])

    // [Y, X], Y first and earlier: Y happened before the wait began, so it must not cancel it.
    const b = await company()
    await emitLeadEvents(db, [
      { type: 'reply_received', company_id: b, source: 'test', occurred_at: at(0) },
      { type: 'email_sent', company_id: b, source: 'test', occurred_at: at(1000) },
    ])
    expect((await delays(t, b)).map((d) => d.status)).toEqual(['pending'])

    // [Y, X], Y listed first but it happened after X: the scan's window check still cancels it.
    const c = await company()
    await emitLeadEvents(db, [
      { type: 'reply_received', company_id: c, source: 'test', occurred_at: at(1000) },
      { type: 'email_sent', company_id: c, source: 'test', occurred_at: at(0) },
    ])
    expect((await delays(t, c)).map((d) => d.status)).toEqual(['pending'])

    await scanDueTriggers(db, ahead(4))
    expect(await fires(t, a)).toBe(0)
    expect(await fires(t, b)).toBe(1)
    expect(await fires(t, c)).toBe(0)
    expect((await delays(t, c)).map((d) => d.status)).toEqual(['cancelled'])
  })

  it('6. a duplicate fire for a delay row is impossible, and a due row is only processed once', async () => {
    const co = await company()
    const t = await trigger()
    await emitLeadEvent(db, { type: 'email_sent', company_id: co, source: 'test' })
    const [{ id }] = (await db.query<{ id: number }>('select id from lp.trigger_delays where trigger_id = $1', [t])).rows
    // A competing scan already wrote this delay's fire.
    await db.query(
      `insert into lp.trigger_fires (trigger_id, company_id, payload, dedupe_key) values ($1, $2, '{}'::jsonb, $3)`,
      [t, co, `delay:${id}`],
    )
    await scanDueTriggers(db, ahead(4))
    await scanDueTriggers(db, ahead(5))
    expect(await fires(t, co)).toBe(1)
    expect((await delays(t)).map((d) => d.status)).toEqual(['fired'])
  })

  it('7. unless_event equal to after_event is rejected', async () => {
    expect(() => validateTriggerConfig('delayed', { after_event: 'email_sent', days: 2, unless_event: 'email_sent' })).toThrow(TriggerError)
    expect(() => validateTriggerConfig('delayed', { after_event: 'email_sent', days: 2, unless_events: ['reply_received', 'email_sent'] }))
      .toThrow(/cancel itself/)
    await expect(runOp(db, 'owner', 'upsert_trigger', {
      name: 'self cancelling', kind: 'delayed', config: { after_event: 'custom', days: 1, unless_event: 'custom' },
    })).rejects.toThrow(/cancel itself/)
  })

  it('8. the N-day clock starts at occurred_at, not when the X was stored', async () => {
    const co = await company()
    const t = await trigger()
    const occurred = ago(10)
    await emitLeadEvent(db, { type: 'email_sent', company_id: co, source: 'test', occurred_at: occurred })
    const { rows } = await db.query<{ ok: boolean }>(
      `select d.due_at = le.occurred_at + interval '3 days' as ok
         from lp.trigger_delays d join lp.lead_events le on le.id = d.source_event_id
        where d.trigger_id = $1`,
      [t],
    )
    expect(rows).toEqual([{ ok: true }])
    // Due 7 days ago, so the next scan at the real time owes the fire.
    await scanDueTriggers(db)
    expect(await fires(t, co)).toBe(1)
  })

  it('9. cancel is scoped to the delay\'s own identity', async () => {
    const co = await company()
    const other = await company()
    const alice = await addContact(db, co, `alice${n}@fix.example`)
    const bob = await addContact(db, co, `bob${n}@fix.example`)
    const t = await trigger()

    // Contact-level wait for Alice.
    await emitLeadEvent(db, { type: 'email_sent', company_id: co, contact_id: alice, source: 'test' })
    // A company-level Y, and a Y for Bob at the same company, do not answer Alice's wait.
    await emitLeadEvent(db, { type: 'reply_received', company_id: co, source: 'test' })
    await emitLeadEvent(db, { type: 'reply_received', company_id: co, contact_id: bob, source: 'test' })
    expect((await delays(t, co)).map((d) => d.status)).toEqual(['pending'])
    // Alice's own Y does.
    await emitLeadEvent(db, { type: 'reply_received', company_id: co, contact_id: alice, source: 'test' })
    expect((await delays(t, co)).map((d) => d.status)).toEqual(['cancelled'])

    // The scan applies the same scoping to a stored Y that never went through emit-time cancel.
    const carol = await addContact(db, other, `carol${n}@fix.example`)
    const dave = await addContact(db, other, `dave${n}@fix.example`)
    await emitLeadEvent(db, { type: 'email_sent', company_id: other, contact_id: carol, source: 'test' })
    await db.query(
      `insert into lp.lead_events (type, company_id, contact_id, source) values ('reply_received', $1, $2, 'test')`,
      [other, dave],
    )
    await db.query(
      `insert into lp.lead_events (type, company_id, source) values ('reply_received', $1, 'test')`,
      [other],
    )
    await scanDueTriggers(db, ahead(4))
    expect(await fires(t, other)).toBe(1)

    // Company-level wait: any Y at that company answers it, a Y at another company does not.
    const t2 = await trigger()
    const acme = await company()
    const elsewhere = await company()
    const erin = await addContact(db, acme, `erin${n}@fix.example`)
    await emitLeadEvent(db, { type: 'email_sent', company_id: acme, source: 'test' })
    await emitLeadEvent(db, { type: 'reply_received', company_id: elsewhere, source: 'test' })
    expect((await delays(t2, acme)).map((d) => d.status)).toEqual(['pending'])
    await emitLeadEvent(db, { type: 'reply_received', company_id: acme, contact_id: erin, source: 'test' })
    expect((await delays(t2, acme)).map((d) => d.status)).toEqual(['cancelled'])
  })

  it('10. the kind check on lp.triggers is the one named triggers_kind_check and allows delayed', async () => {
    const { rows } = await db.query<{ conname: string; def: string }>(
      `select conname, pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'lp.triggers'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%'`,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].conname).toBe('triggers_kind_check')
    expect(rows[0].def).toContain("'delayed'")
  })
})
