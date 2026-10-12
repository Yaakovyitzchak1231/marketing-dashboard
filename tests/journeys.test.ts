import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'
import { emitLeadEvent } from '@/lib/events/emit'
import { runOp } from '@/lib/ops/dispatch'
import { GraphError, validateGraph } from '@/lib/journeys/graph'
import { registerNodeHandler } from '@/lib/journeys/nodes'
import { advanceRun, runDueJourneys } from '@/lib/journeys/runner'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

const LINEAR = {
  start: 'hello',
  nodes: [
    { id: 'hello', kind: 'note', next: 'pause' },
    { id: 'pause', kind: 'wait', config: { days: 2 }, next: 'bye' },
    { id: 'bye', kind: 'note' },
  ],
}

function errorsOf(graph: unknown): string[] {
  try {
    validateGraph(graph)
    return []
  } catch (e) {
    if (e instanceof GraphError) return e.errors
    throw e
  }
}

describe('journey graph validation (plan 3.1)', () => {
  it('accepts a linear graph and a loop, and normalises missing fields', () => {
    const g = validateGraph(LINEAR)
    expect(g.nodes[2]).toEqual({ id: 'bye', kind: 'note', config: {}, next: null, paths: [] })
    expect(errorsOf({ start: 'a', nodes: [{ id: 'a', kind: 'wait', config: { hours: 1 }, next: 'a' }] })).toEqual([])
  })

  it('names every problem: unknown kind, dangling edge, bad start, unreachable node, bad wait, exit with next', () => {
    expect(errorsOf({ start: 'a', nodes: [{ id: 'a', kind: 'teleport' }] }).join()).toMatch(/unknown kind 'teleport'/)
    expect(errorsOf({ start: 'a', nodes: [{ id: 'a', kind: 'note', next: 'zz' }] }).join()).toMatch(/unknown node 'zz'/)
    expect(errorsOf({ start: 'nope', nodes: [{ id: 'a', kind: 'note' }] }).join()).toMatch(/start 'nope'/)
    expect(errorsOf({ start: 'a', nodes: [{ id: 'a', kind: 'note' }, { id: 'b', kind: 'note' }] }).join()).toMatch(/unreachable from start: b/)
    expect(errorsOf({ start: 'a', nodes: [{ id: 'a', kind: 'wait', config: {} }] }).join()).toMatch(/more than 0/)
    expect(errorsOf({ start: 'a', nodes: [{ id: 'a', kind: 'wait', config: { days: -1 } }] }).join()).toMatch(/>= 0/)
    expect(errorsOf({ start: 'a', nodes: [{ id: 'a', kind: 'exit', next: 'a' }] }).join()).toMatch(/cannot have next/)
    expect(errorsOf({ start: 'a', nodes: [{ id: 'a', kind: 'note' }, { id: 'a', kind: 'note' }] }).join()).toMatch(/duplicate node id/)
    expect(errorsOf('nope')).toHaveLength(1)
  })
})

describe('journeys: model, versions and the runner (plan 3.1)', () => {
  let db: TestDb
  let co: number
  let co2: number
  const day = 24 * 3600_000

  beforeAll(async () => {
    db = await createTestDb()
    co = await addCompany(db, { name: 'Gem Co', domain: 'gemco.example', city: 'Towson' })
    co2 = await addCompany(db, { name: 'Ring Co', domain: 'ringco.example', city: 'Towson' })
    await db.tx(async (q) => {
      await q.query(`insert into lp.actors (id, kind, display_name, email, role, active) values ('vera', 'human', 'Vera', 'vera@example.com', 'viewer', true)`)
      await q.query(`insert into lp.actors (id, kind, display_name, email, role, active) values ('eddie', 'human', 'Eddie', 'eddie@example.com', 'editor', true)`)
    }, 'owner')
  })
  afterAll(async () => db.close())

  async function run(id: number) {
    const { rows } = await db.query<{ status: string; node_id: string; version: number; next_run_at: Date | null; last_error: string | null }>(
      'select status, node_id, version, next_run_at, last_error from lp.journey_runs where id = $1', [id],
    )
    return rows[0]
  }

  it('builds, publishes, goes live, enrols, waits, and finishes — logging each step and the enter/leave events', async () => {
    const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Nurture' }) as { id: number; status: string }
    expect(j.status).toBe('draft')
    await expect(runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })).rejects.toMatchObject({ status: 409 })
    await expect(runOp(db, 'owner', 'journey_publish', { journey_id: j.id, graph: { start: 'x', nodes: [] } })).rejects.toMatchObject({ status: 400 })
    const v1 = await runOp(db, 'owner', 'journey_publish', { journey_id: j.id, graph: LINEAR, note: 'first' }) as { version: number }
    expect(v1.version).toBe(1)
    await expect(runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co })).rejects.toMatchObject({ status: 409 })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })

    const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co }) as { enrolled: number; results: { run_id: number }[] }
    expect(en.enrolled).toBe(1)
    const runId = en.results[0].run_id

    const t0 = new Date()
    const tick1 = await runDueJourneys(db, { now: t0 })
    expect(tick1.advanced).toBeGreaterThanOrEqual(1)
    let r = await run(runId)
    expect(r.status).toBe('waiting')
    expect(r.node_id).toBe('pause')
    expect(new Date(r.next_run_at as Date).getTime()).toBeGreaterThan(t0.getTime() + day)

    // Publishing v2 while the run waits: the run stays on v1, a new lead gets v2.
    const v2 = await runOp(db, 'owner', 'journey_publish', {
      journey_id: j.id, graph: { start: 'out', nodes: [{ id: 'out', kind: 'exit', config: { reason: 'v2' } }] },
    }) as { version: number }
    expect(v2.version).toBe(2)
    const en2 = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co2 }) as { results: { run_id: number }[] }
    await runDueJourneys(db, { now: new Date(Date.now() + 1000) })
    expect(await run(en2.results[0].run_id)).toMatchObject({ status: 'exited', version: 2 })

    // Too early: nothing moves. After the wait: it finishes on v1's path.
    expect((await advanceRun(db, runId, new Date(t0.getTime() + day))).advanced).toBe(false)
    await runDueJourneys(db, { now: new Date(t0.getTime() + 3 * day) })
    r = await run(runId)
    expect(r).toMatchObject({ status: 'done', node_id: 'bye', version: 1 })

    const log = await runOp(db, 'eddie', 'journey_run_log', { run_id: runId }) as { steps: { node_id: string; action: string }[] }
    expect(log.steps.map((s) => `${s.node_id}:${s.action}`)).toEqual(['hello:entered', 'hello:note', 'pause:wait:wait', 'pause:wait', 'bye:note'])
    const { rows: ev } = await db.query<{ type: string }>(
      `select type from lp.lead_events where company_id = $1 and type like 'journey_%' order by id`, [co],
    )
    expect(ev.map((e) => e.type)).toEqual(['journey_entered', 'journey_finished'])

    const got = await runOp(db, 'vera', 'journey_get', { journey_id: j.id }) as { version: number; versions: unknown[]; counts: Record<string, number> }
    expect(got.version).toBe(2)
    expect(got.versions).toHaveLength(2)
    expect(got.counts).toEqual({ done: 1, exited: 1 })
  })

  it("entry once vs multiple, and one open run per lead", async () => {
    const graph = { start: 'w', nodes: [{ id: 'w', kind: 'wait', config: { hours: 1 } }] }
    const once = await runOp(db, 'owner', 'journey_upsert', { name: 'Once' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', { journey_id: once.id, graph })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: once.id, status: 'live' })
    const a = await runOp(db, 'owner', 'journey_enroll', { journey_id: once.id, company_ids: [co, co] }) as { enrolled: number; results: { reason?: string }[] }
    expect(a.enrolled).toBe(1)
    expect(a.results[1].reason).toBe('already_entered')

    const multi = await runOp(db, 'owner', 'journey_upsert', { name: 'Multi', entry_mode: 'multiple' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', { journey_id: multi.id, graph })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: multi.id, status: 'live' })
    const b = await runOp(db, 'owner', 'journey_enroll', { journey_id: multi.id, company_ids: [co, co] }) as { enrolled: number; results: { run_id: number; reason?: string }[] }
    expect(b.enrolled).toBe(1)
    expect(b.results[1].reason).toBe('already_in')
    const ex = await runOp(db, 'owner', 'journey_exit', { journey_id: multi.id, company_id: co }) as { exited: number[] }
    expect(ex.exited).toEqual([b.results[0].run_id])
    const c = await runOp(db, 'owner', 'journey_enroll', { journey_id: multi.id, company_id: co }) as { enrolled: number }
    expect(c.enrolled).toBe(1)
  })

  it('enrols from its 3.2 trigger fires once each, only while live, and not from fires before it existed', async () => {
    const trig = await runOp(db, 'owner', 'upsert_trigger', { name: 'On custom (journey)', kind: 'event', config: { event_type: 'custom' } }) as { id: number }
    await emitLeadEvent(db, { type: 'custom', company_id: co2, source: 'test' }) // before the journey: not replayed
    const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Triggered', trigger_id: trig.id, entry_mode: 'multiple' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', { journey_id: j.id, graph: { start: 'w', nodes: [{ id: 'w', kind: 'wait', config: { days: 1 } }] } })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'testing' })
    await emitLeadEvent(db, { type: 'custom', company_id: co, source: 'test' })
    expect((await runDueJourneys(db)).enrolled_from_triggers).toBe(0) // testing: fires wait
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    expect((await runDueJourneys(db)).enrolled_from_triggers).toBe(0) // going live does not replay the fire from testing
    await emitLeadEvent(db, { type: 'custom', company_id: co, source: 'test' })
    expect((await runDueJourneys(db)).enrolled_from_triggers).toBe(1)
    expect((await runDueJourneys(db)).enrolled_from_triggers).toBe(0)
    const runs = await runOp(db, 'owner', 'journey_runs', { journey_id: j.id }) as { runs: { company_id: number; source: string; status: string }[] }
    expect(runs.runs).toHaveLength(1)
    expect(runs.runs[0]).toMatchObject({ company_id: co, source: 'trigger', status: 'waiting' })
  })

  it('editing a journey keeps the fields the edit did not send', async () => {
    const trig = await runOp(db, 'owner', 'upsert_trigger', { name: 'Keep me (journey)', kind: 'event', config: { event_type: 'custom' } }) as { id: number }
    const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Keeps', trigger_id: trig.id, entry_mode: 'multiple' }) as { id: number }
    await expect(runOp(db, 'owner', 'journey_upsert', { id: j.id, name: 'Renamed' }))
      .resolves.toMatchObject({ name: 'Renamed', trigger_id: trig.id, entry_mode: 'multiple' })
    await expect(runOp(db, 'owner', 'journey_upsert', { id: j.id, name: 'Renamed', trigger_id: null }))
      .resolves.toMatchObject({ trigger_id: null, entry_mode: 'multiple' })
  })

  it('a node that throws is retried, then only its run is marked error; a paused journey does not move', async () => {
    registerNodeHandler({ kind: 'boom_test', validate: () => [], run: async () => { throw new Error('kaboom') } })
    const bad = await runOp(db, 'owner', 'journey_upsert', { name: 'Bad' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', { journey_id: bad.id, graph: { start: 'b', nodes: [{ id: 'b', kind: 'boom_test' }] } })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: bad.id, status: 'live' })
    const good = await runOp(db, 'owner', 'journey_upsert', { name: 'Good' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', { journey_id: good.id, graph: { start: 'n', nodes: [{ id: 'n', kind: 'note' }] } })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: good.id, status: 'live' })
    const rb = await runOp(db, 'owner', 'journey_enroll', { journey_id: bad.id, company_id: co2 }) as { results: { run_id: number }[] }
    const rg = await runOp(db, 'owner', 'journey_enroll', { journey_id: good.id, company_id: co2 }) as { results: { run_id: number }[] }
    await runOp(db, 'owner', 'journey_set_status', { journey_id: good.id, status: 'paused' })
    const tick = await runDueJourneys(db)
    expect(tick.errors).toBe(0)
    expect(await run(rb.results[0].run_id)).toMatchObject({ status: 'active', last_error: 'kaboom' })
    expect((await run(rg.results[0].run_id)).status).toBe('active')
    // Attempts two and three (the backoff is 5, then 30 minutes; ticks two days apart are past both).
    const later = new Date(Date.now() + 2 * day)
    await runDueJourneys(db, { now: later })
    const last = await runDueJourneys(db, { now: new Date(later.getTime() + day) })
    expect(last.errors).toBe(1)
    expect(await run(rb.results[0].run_id)).toMatchObject({ status: 'error', last_error: 'kaboom' })
    await expect(runOp(db, 'owner', 'journey_retry', { run_id: rb.results[0].run_id })).resolves.toMatchObject({ status: 'active' })
    await expect(runOp(db, 'owner', 'journey_retry', { run_id: rg.results[0].run_id })).rejects.toMatchObject({ status: 409 })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: good.id, status: 'live' })
    await runDueJourneys(db)
    expect((await run(rg.results[0].run_id)).status).toBe('done')
    await expect(runOp(db, 'owner', 'journey_set_status', { journey_id: good.id, status: 'draft' })).resolves.toMatchObject({ status: 'draft' })
  })

  it('roles: a Viewer reads but cannot write; an Editor writes; the tick is owner or system only', async () => {
    await expect(runOp(db, 'vera', 'journey_list', {})).resolves.toMatchObject({ node_kinds: expect.arrayContaining(['wait', 'exit', 'note']) })
    await expect(runOp(db, 'vera', 'journey_upsert', { name: 'Nope' })).rejects.toMatchObject({ status: 403 })
    await expect(runOp(db, 'vera', 'journey_enroll', { journey_id: 1, company_id: co })).rejects.toMatchObject({ status: 403 })
    const j = await runOp(db, 'eddie', 'journey_upsert', { name: 'Eddie built this' }) as { id: number; created_by: string }
    expect(j.created_by).toBe('eddie')
    await expect(runOp(db, 'eddie', 'journey_publish', { journey_id: j.id, graph: LINEAR })).resolves.toMatchObject({ version: 1 })
    await expect(runOp(db, 'eddie', 'run_journeys', {})).rejects.toMatchObject({ status: 403 })
    await expect(runOp(db, 'system', 'run_journeys', {})).resolves.toMatchObject({ errors: 0 })
    const { rows } = await db.query<{ field: string; changed_by: string }>(
      `select field, changed_by from lp.status_history where entity_type = 'journey' and entity_id = $1 order by changed_at, id`, [j.id],
    )
    expect(rows.map((r) => r.field)).toEqual(['created', 'version'])
  })

  it('approval is per version: approving v2 does not release a v1 run, and approving v1 does', async () => {
    registerNodeHandler({ kind: 'sendish_test', sends: true, validate: () => [], run: async () => ({ type: 'next' }) })
    const far = new Date(Date.now() + 40 * day)
    const graph = { start: 's', nodes: [{ id: 's', kind: 'sendish_test' }] }
    const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Approvals', entry_mode: 'multiple' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', { journey_id: j.id, graph })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const a = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co }) as { results: { run_id: number }[] }
    await runDueJourneys(db, { now: far })
    expect(await run(a.results[0].run_id)).toMatchObject({ status: 'waiting', node_id: 's', version: 1 })
    await expect(runOp(db, 'eddie', 'journey_approve', { journey_id: j.id })).rejects.toMatchObject({ status: 403 })

    await runOp(db, 'owner', 'journey_publish', { journey_id: j.id, graph })
    await runOp(db, 'owner', 'journey_approve', { journey_id: j.id, version: 2 })
    const b = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co2 }) as { results: { run_id: number }[] }
    await runDueJourneys(db, { now: new Date(far.getTime() + 3 * 3600_000) })
    expect(await run(b.results[0].run_id)).toMatchObject({ status: 'done', version: 2 })
    // v1 is still unapproved, so its run waits (re-checked hourly) even though v2 is approved.
    await runDueJourneys(db, { now: new Date(far.getTime() + 4 * 3600_000) })
    expect(await run(a.results[0].run_id)).toMatchObject({ status: 'waiting', version: 1 })
    const log = await runOp(db, 'owner', 'journey_run_log', { run_id: a.results[0].run_id }) as { steps: { action: string }[] }
    expect(log.steps.map((s) => s.action)).toContain('awaiting_approval')

    await runOp(db, 'owner', 'journey_approve', { journey_id: j.id, version: 1 })
    await runDueJourneys(db, { now: new Date(far.getTime() + 6 * 3600_000) })
    expect(await run(a.results[0].run_id)).toMatchObject({ status: 'done', version: 1 })
  })

  it('attempts count only failures since the last success, so a recovered run is not closer to error', async () => {
    const left: Record<string, number> = { fa: 1, fb: 2 }
    registerNodeHandler({
      kind: 'flaky_test',
      validate: () => [],
      run: async ({ node }) => {
        if ((left[node.id] ?? 0) > 0) {
          left[node.id]--
          throw new Error(`flaky ${node.id}`)
        }
        return { type: 'next' }
      },
    })
    const co3 = await addCompany(db, { name: 'Pearl Co', domain: 'pearl.example', city: 'Towson' })
    const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Flaky', entry_mode: 'multiple' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', {
      journey_id: j.id,
      graph: {
        start: 'fa',
        nodes: [
          { id: 'fa', kind: 'flaky_test', next: 'w' },
          { id: 'w', kind: 'wait', config: { hours: 1 }, next: 'fb' },
          { id: 'fb', kind: 'flaky_test' },
        ],
      },
    })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co3 }) as { results: { run_id: number }[] }
    const runId = en.results[0].run_id
    const attempts = async () => (await db.query<{ attempts: number }>('select attempts from lp.journey_runs where id = $1', [runId])).rows[0].attempts
    const T = Date.now() + 60 * day

    await runDueJourneys(db, { now: new Date(T) }) // fa throws (1)
    expect(await run(runId)).toMatchObject({ status: 'active', node_id: 'fa' })
    expect(await attempts()).toBe(1)
    await runDueJourneys(db, { now: new Date(T + 2 * day) }) // fa succeeds, the wait commits
    expect(await run(runId)).toMatchObject({ status: 'waiting', node_id: 'w' })
    expect(await attempts()).toBe(0)
    await runDueJourneys(db, { now: new Date(T + 3 * day) }) // fb throws (1 since the success)
    expect(await run(runId)).toMatchObject({ status: 'active', node_id: 'fb' })
    expect(await attempts()).toBe(1)
    await runDueJourneys(db, { now: new Date(T + 5 * day) }) // fb throws (2): still not error
    expect(await run(runId)).toMatchObject({ status: 'active', node_id: 'fb' })
    expect(await attempts()).toBe(2)
    await runDueJourneys(db, { now: new Date(T + 7 * day) })
    expect(await run(runId)).toMatchObject({ status: 'done' })
  })

  it('resuming a paused journey moves its waits forward by the pause; fires from the pause are not replayed', async () => {
    const trig = await runOp(db, 'owner', 'upsert_trigger', { name: 'Resume (journey)', kind: 'event', config: { event_type: 'custom' } }) as { id: number }
    const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Pausable', trigger_id: trig.id, entry_mode: 'multiple' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', { journey_id: j.id, graph: { start: 'w', nodes: [{ id: 'w', kind: 'wait', config: { days: 3 } }] } })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co }) as { results: { run_id: number }[] }
    const runId = en.results[0].run_id
    await runDueJourneys(db)
    const before = new Date((await run(runId)).next_run_at as Date).getTime()

    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'paused' })
    await emitLeadEvent(db, { type: 'custom', company_id: co2, source: 'test' }) // fired while paused
    await db.query(`update lp.journeys set paused_at = now() - interval '2 days' where id = $1`, [j.id])
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const after = new Date((await run(runId)).next_run_at as Date).getTime()
    expect(Math.abs(after - before - 2 * day)).toBeLessThan(60_000)
    expect((await runDueJourneys(db)).enrolled_from_triggers).toBe(0)
  })

  it('journey_enroll reports a lead that fails its own checks and still enrols the rest', async () => {
    const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Batch', entry_mode: 'multiple' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', { journey_id: j.id, graph: { start: 'w', nodes: [{ id: 'w', kind: 'wait', config: { hours: 1 } }] } })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const r = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_ids: [co, 999999, co2] }) as {
      enrolled: number; failed: number; results: { reason?: string; error?: string }[]
    }
    expect(r).toMatchObject({ enrolled: 2, failed: 1 })
    expect(r.results[1]).toMatchObject({ reason: 'invalid', error: expect.stringMatching(/no company 999999/) })
  })

  it('the tick stops taking runs when its time budget is spent, and leaves the rest for the next tick', async () => {
    const r = await runDueJourneys(db, { now: new Date(Date.now() + 80 * day), budgetMs: 0 })
    expect(r.advanced).toBe(0)
    expect(r.deadline_reached).toBe(r.due > 0)
  })

  it("a caller cannot claim the runner's own event dedupe keys", async () => {
    await expect(runOp(db, 'owner', 'track_event', { type: 'custom', company_id: co, dedupe_key: 'journey_entered:1' }))
      .rejects.toThrow(/reserved for the journey runner/)
  })

  it('the migration is safe to run twice', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const sql = readFileSync(join(__dirname, '..', 'db', 'migrations', '0057_journeys.sql'), 'utf8')
    const statements = sql.replace(/^--.*$/gm, '').split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)
    for (const s of statements) await db.query(s)
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from lp.jobs where name = 'journey_tick'`)
    expect(rows[0].n).toBe(1)
  })
})
