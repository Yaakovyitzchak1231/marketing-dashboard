import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { emitLeadEvent } from '@/lib/events/emit'
import { runOp } from '@/lib/ops/dispatch'
import { runDueJourneys } from '@/lib/journeys/runner'
import { getVersionGraph } from '@/lib/journeys/store'
import { validateGraph } from '@/lib/journeys/graph'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('wait and drop if replied (plan 3.4)', () => {
  let db: TestDb
  let co: number

  beforeAll(async () => {
    db = await createTestDb()
    co = await addCompany(db, { name: 'Wait Co', domain: 'wait.example', city: 'Towson' })
  })
  afterAll(async () => db.close())

  it('drops the run when a reply lands during the wait', async () => {
    const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Drop on reply' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', {
      journey_id: j.id,
      graph: { start: 'hold', nodes: [{ id: 'hold', kind: 'wait', config: { days: 3, drop_if_replied: true }, next: 'done' }, { id: 'done', kind: 'note' }] },
    })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co }) as { results: { run_id: number }[] }
    const runId = en.results[0].run_id
    await runDueJourneys(db)
    await emitLeadEvent(db, { type: 'reply_received', company_id: co, source: 'test' })
    await runDueJourneys(db, { now: new Date(Date.now() + 60_000) })
    const { rows } = await db.query<{ status: string }>(
      'select status from lp.journey_runs where id = $1',
      [runId],
    )
    expect(rows[0].status).toBe('exited')
  })

  it('waits until an absolute time when no reply arrives', async () => {
    const until = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Until slot' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', {
      journey_id: j.id,
      graph: { start: 'hold', nodes: [{ id: 'hold', kind: 'wait', config: { until }, next: 'done' }, { id: 'done', kind: 'note' }] },
    })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co }) as { results: { run_id: number }[] }
    await runDueJourneys(db)
    const early = await db.query<{ status: string }>('select status from lp.journey_runs where id = $1', [en.results[0].run_id])
    expect(early.rows[0].status).toBe('waiting')
    await runDueJourneys(db, { now: new Date(Date.now() + 3 * 60 * 60 * 1000) })
    const late = await db.query<{ status: string }>('select status from lp.journey_runs where id = $1', [en.results[0].run_id])
    expect(late.rows[0].status).toBe('done')
  })

  function errorsOf(config: Record<string, unknown>): string[] {
    try {
      validateGraph({ start: 'w', nodes: [{ id: 'w', kind: 'wait', config: { days: 1, ...config } }] })
      return []
    } catch (e) {
      return (e as { errors?: string[] }).errors ?? [String(e)]
    }
  }

  async function liveJourney(name: string, graph: unknown) {
    const j = await runOp(db, 'owner', 'journey_upsert', { name }) as { id: number }
    const pub = await runOp(db, 'owner', 'journey_publish', { journey_id: j.id, graph }) as { version: number }
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    return { id: j.id, version: pub.version }
  }

  async function enroll(journeyId: number, companyId: number): Promise<number> {
    const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: journeyId, company_id: companyId }) as { results: { run_id: number }[] }
    return en.results[0].run_id
  }

  async function status(runId: number) {
    const { rows } = await db.query<{ status: string; last_error: string | null }>('select status, last_error from lp.journey_runs where id = $1', [runId])
    return rows[0]
  }

  const REPLY_THEN_WAIT = {
    start: 'first',
    nodes: [
      { id: 'first', kind: 'wait', config: { minutes: 5 }, next: 'hold' },
      { id: 'hold', kind: 'wait', config: { days: 3, drop_if_replied: true }, next: 'done' },
      { id: 'done', kind: 'note' },
    ],
  }

  it('publishing leaves the node config untouched, so drop_if_replied can be turned off later', async () => {
    const graph = { start: 'w', nodes: [{ id: 'w', kind: 'wait', config: { days: 1, drop_if: ['custom'], drop_if_replied: true } }] }
    const before = JSON.stringify(graph)
    expect(errorsOf({ drop_if: ['custom'], drop_if_replied: true })).toEqual([])
    validateGraph(graph)
    expect(JSON.stringify(graph)).toBe(before)
    const { id, version } = await liveJourney('Config stays put', graph)
    const stored = await getVersionGraph(db, id, version)
    expect(stored?.nodes[0].config).toEqual({ days: 1, drop_if: ['custom'], drop_if_replied: true })

    // v2 with drop_if_replied off: a reply no longer drops the run.
    const off = { start: 'w', nodes: [{ id: 'w', kind: 'wait', config: { days: 1, drop_if: ['custom'], drop_if_replied: false } }] }
    await runOp(db, 'owner', 'journey_publish', { journey_id: id, graph: off })
    const c = await addCompany(db, { name: 'Replied Off', domain: 'replied-off.example', city: 'Towson' })
    const runId = await enroll(id, c)
    await runDueJourneys(db)
    await emitLeadEvent(db, { type: 'reply_received', company_id: c, source: 'test' })
    await runDueJourneys(db, { now: new Date(Date.now() + 60_000) })
    expect((await status(runId)).status).toBe('waiting')
  })

  it('accepts dotted event types in drop_if, and a dotted event drops the run', async () => {
    await runOp(db, 'owner', 'register_event_type', { key: 'review.posted', label: 'Review posted', category: 'custom' })
    expect(errorsOf({ drop_if: 'review.posted' })).toEqual([])
    expect(errorsOf({ drop_if: ['review.posted', 'reply_received'] })).toEqual([])
    const c = await addCompany(db, { name: 'Dotted Co', domain: 'dotted.example', city: 'Towson' })
    const { id } = await liveJourney('Dotted drop', { start: 'w', nodes: [{ id: 'w', kind: 'wait', config: { days: 2, drop_if: 'review.posted' } }] })
    const runId = await enroll(id, c)
    await runDueJourneys(db)
    await emitLeadEvent(db, { type: 'review.posted', company_id: c, source: 'test' })
    await runDueJourneys(db, { now: new Date(Date.now() + 60_000) })
    expect((await status(runId)).status).toBe('exited')
  })

  it('rejects each bad drop_if entry, even when drop_if_replied is on (never silently filters)', () => {
    expect(errorsOf({ drop_if: 'reply recieved' }).join()).toMatch(/'reply recieved'/)
    expect(errorsOf({ drop_if: ['reply_received', 'reply recieved'], drop_if_replied: true }).join()).toMatch(/'reply recieved'/)
    expect(errorsOf({ drop_if: ['Reply_Received'], drop_if_replied: true }).join()).toMatch(/'Reply_Received'/)
    expect(errorsOf({ drop_if: [42], drop_if_replied: true }).join()).toMatch(/'42'/)
    expect(errorsOf({ drop_if: [], drop_if_replied: false }).join()).toMatch(/empty/)
    expect(errorsOf({ drop_if_replied: 'yes' }).join()).toMatch(/true or false/)
    const two = errorsOf({ drop_if: ['bad one', 'bad two'] })
    expect(two.length).toBe(2)
  })

  it('publish refuses a graph with a mistyped drop_if', async () => {
    const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Typo' }) as { id: number }
    await expect(runOp(db, 'owner', 'journey_publish', {
      journey_id: j.id,
      graph: { start: 'w', nodes: [{ id: 'w', kind: 'wait', config: { days: 1, drop_if: 'reply recieved', drop_if_replied: true } }] },
    })).rejects.toMatchObject({ status: 400 })
  })

  it('fails the run loudly when a well-formed drop type is not registered', async () => {
    const c = await addCompany(db, { name: 'Unregistered', domain: 'unregistered.example', city: 'Towson' })
    const { id } = await liveJourney('Unregistered drop', { start: 'w', nodes: [{ id: 'w', kind: 'wait', config: { days: 2, drop_if: 'reply_recieved' } }] })
    const runId = await enroll(id, c)
    // The runner retries a failing node (backoff 1, then 5 minutes) and marks the run
    // error on the third failure. The message names the bad type each time.
    await runDueJourneys(db)
    expect(await status(runId)).toMatchObject({ status: 'active', last_error: expect.stringMatching(/reply_recieved/) })
    const later = new Date(Date.now() + 2 * 24 * 3600_000)
    await runDueJourneys(db, { now: later })
    await runDueJourneys(db, { now: new Date(later.getTime() + 24 * 3600_000) })
    expect(await status(runId)).toMatchObject({ status: 'error', last_error: expect.stringMatching(/reply_recieved/) })
  })

  it('does not drop for a reply that happened before the lead entered the journey', async () => {
    const c = await addCompany(db, { name: 'Early Reply', domain: 'early-reply.example', city: 'Towson' })
    await emitLeadEvent(db, { type: 'reply_received', company_id: c, source: 'test' })
    await new Promise((r) => setTimeout(r, 25))
    const { id } = await liveJourney('Reply before entry', REPLY_THEN_WAIT)
    const runId = await enroll(id, c)
    await runDueJourneys(db)
    await runDueJourneys(db, { now: new Date(Date.now() + 10 * 60_000) }) // past the first wait, now at the drop wait
    expect(await status(runId)).toMatchObject({ status: 'waiting' })
  })

  it('drops for a reply after entry but before the lead reached the wait node', async () => {
    const c = await addCompany(db, { name: 'Mid Reply', domain: 'mid-reply.example', city: 'Towson' })
    const { id } = await liveJourney('Reply before the wait node', REPLY_THEN_WAIT)
    const runId = await enroll(id, c)
    await runDueJourneys(db) // parked on the 5 minute wait
    await emitLeadEvent(db, { type: 'reply_received', company_id: c, source: 'test' })
    await runDueJourneys(db, { now: new Date(Date.now() + 10 * 60_000) }) // reaches the drop wait afterwards
    expect((await status(runId)).status).toBe('exited')
    const { rows } = await db.query<{ node_id: string; result: { dropped?: string } }>(
      `select node_id, result from lp.journey_steps_log where run_id = $1 and action = 'wait:exited'`, [runId])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ node_id: 'hold', result: { dropped: 'reply_received' } })
  })

  it('places a backfilled reply by occurred_at: old does not drop, one after entry does', async () => {
    const old = await addCompany(db, { name: 'Backfill Old', domain: 'backfill-old.example', city: 'Towson' })
    const fresh = await addCompany(db, { name: 'Backfill New', domain: 'backfill-new.example', city: 'Towson' })
    const { id } = await liveJourney('Backfilled replies', { start: 'w', nodes: [{ id: 'w', kind: 'wait', config: { days: 3, drop_if_replied: true } }] })
    const oldRun = await enroll(id, old)
    const newRun = await enroll(id, fresh)
    await runDueJourneys(db)
    // Both rows are recorded just now (as a reconcile would), but they happened at different times.
    await emitLeadEvent(db, { type: 'reply_received', company_id: old, source: 'backfill', occurred_at: new Date(Date.now() - 24 * 3600_000) })
    await emitLeadEvent(db, { type: 'reply_received', company_id: fresh, source: 'backfill', occurred_at: new Date(Date.now() + 1000) })
    await runDueJourneys(db, { now: new Date(Date.now() + 60_000) })
    expect((await status(oldRun)).status).toBe('waiting')
    expect((await status(newRun)).status).toBe('exited')
  })

  it('a contact run is not dropped by a colleague\'s reply, but is dropped by its own contact\'s reply', async () => {
    const c = await addCompany(db, { name: 'Colleagues', domain: 'colleagues.example', city: 'Towson' })
    const mine = await addContact(db, c, 'me@colleagues.example')
    const colleague = await addContact(db, c, 'them@colleagues.example')
    const { id } = await liveJourney('Contact grain drop', { start: 'w', nodes: [{ id: 'w', kind: 'wait', config: { days: 3, drop_if_replied: true } }] })
    const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: id, contact_id: mine }) as { results: { run_id: number }[] }
    const runId = en.results[0].run_id
    await runDueJourneys(db) // parked on the wait

    // A different contact at the same company replies, reported by email as a webhook does. The
    // emit path fills company_id on the row, but the run belongs to `mine`, so it must not count.
    await emitLeadEvent(db, { type: 'reply_received', email: 'them@colleagues.example', source: 'test' })
    const row = await db.query<{ company_id: number; contact_id: number }>(
      `select company_id, contact_id from lp.lead_events where type = 'reply_received' and contact_id = $1`, [colleague])
    expect(row.rows[0]).toMatchObject({ company_id: c, contact_id: colleague })
    await runDueJourneys(db, { now: new Date(Date.now() + 60_000) })
    expect((await status(runId)).status).toBe('waiting')

    // The run's own contact replies: now it drops.
    await emitLeadEvent(db, { type: 'reply_received', email: 'me@colleagues.example', source: 'test' })
    await runDueJourneys(db, { now: new Date(Date.now() + 2 * 60_000) })
    expect((await status(runId)).status).toBe('exited')
    const log = await db.query<{ result: { dropped?: string } }>(
      `select result from lp.journey_steps_log where run_id = $1 and action = 'wait:exited'`, [runId])
    expect(log.rows[0].result).toMatchObject({ dropped: 'reply_received' })
  })

  it('a company run is still dropped by an event for its company', async () => {
    const c = await addCompany(db, { name: 'Company Grain', domain: 'company-grain.example', city: 'Towson' })
    await addContact(db, c, 'x@company-grain.example')
    const { id } = await liveJourney('Company grain drop', { start: 'w', nodes: [{ id: 'w', kind: 'wait', config: { days: 3, drop_if_replied: true } }] })
    const runId = await enroll(id, c)
    await runDueJourneys(db)
    await emitLeadEvent(db, { type: 'reply_received', email: 'x@company-grain.example', source: 'test' })
    await runDueJourneys(db, { now: new Date(Date.now() + 60_000) })
    expect((await status(runId)).status).toBe('exited')
  })
})
