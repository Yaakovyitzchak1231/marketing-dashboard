import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { emitLeadEvent } from '@/lib/events/emit'
import { runOp } from '@/lib/ops/dispatch'
import { GraphError, validateGraph } from '@/lib/journeys/graph'
import { registerNodeHandler } from '@/lib/journeys/nodes'
import { advanceRun, runDueJourneys } from '@/lib/journeys/runner'
import { setJourneyStatus } from '@/lib/journeys/store'
import { addSuppressionIn } from '@/lib/suppressions/store'

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
  const minute = 60_000

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
    await expect(runOp(db, 'owner', 'journey_approve', { journey_id: j.id, version: 9 })).rejects.toMatchObject({ status: 404 })
    await runOp(db, 'owner', 'journey_approve', { journey_id: j.id, version: 2 })
    // The approval is stored on the version it names, and only on that one.
    const approvals = async () => (await db.query<{ version: number; approved_by: string | null }>(
      'select version, approved_by from lp.journey_versions where journey_id = $1 order by version', [j.id],
    )).rows
    expect(await approvals()).toEqual([{ version: 1, approved_by: null }, { version: 2, approved_by: 'owner' }])
    const b = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co2 }) as { results: { run_id: number }[] }
    await runDueJourneys(db, { now: new Date(far.getTime() + 3 * 3600_000) })
    expect(await run(b.results[0].run_id)).toMatchObject({ status: 'done', version: 2 })
    // v1 is still unapproved, so its run waits (re-checked hourly) even though v2 is approved.
    await runDueJourneys(db, { now: new Date(far.getTime() + 4 * 3600_000) })
    expect(await run(a.results[0].run_id)).toMatchObject({ status: 'waiting', version: 1 })
    const log = await runOp(db, 'owner', 'journey_run_log', { run_id: a.results[0].run_id }) as { steps: { action: string }[] }
    expect(log.steps.map((s) => s.action)).toContain('awaiting_approval')

    await runOp(db, 'owner', 'journey_approve', { journey_id: j.id, version: 1 })
    expect(await approvals()).toEqual([{ version: 1, approved_by: 'owner' }, { version: 2, approved_by: 'owner' }])
    await runDueJourneys(db, { now: new Date(far.getTime() + 6 * 3600_000) })
    expect(await run(a.results[0].run_id)).toMatchObject({ status: 'done', version: 1 })

    // With no version given, the current one is approved (a fresh v3 starts unapproved).
    await runOp(db, 'owner', 'journey_publish', { journey_id: j.id, graph })
    expect((await approvals())[2]).toEqual({ version: 3, approved_by: null })
    await runOp(db, 'owner', 'journey_approve', { journey_id: j.id })
    expect((await approvals())[2]).toEqual({ version: 3, approved_by: 'owner' })
  })

  it('attempts count only failures since the last success: fail once at A, recover, fail twice at B is not error and backoff restarts at 1 minute', async () => {
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
    const dueAt = async () => new Date((await run(runId)).next_run_at as Date).getTime()
    const T = Date.now() + 60 * day

    await runDueJourneys(db, { now: new Date(T) }) // fa throws (1): retry in 1 minute
    expect(await run(runId)).toMatchObject({ status: 'active', node_id: 'fa' })
    expect(await attempts()).toBe(1)
    expect(await dueAt()).toBe(T + 1 * minute)
    await runDueJourneys(db, { now: new Date(T + 2 * day) }) // fa succeeds, the wait commits
    expect(await run(runId)).toMatchObject({ status: 'waiting', node_id: 'w' })
    expect(await attempts()).toBe(0)
    await runDueJourneys(db, { now: new Date(T + 3 * day) }) // fb throws (1 since the success): 1 minute again, not 5
    expect(await run(runId)).toMatchObject({ status: 'active', node_id: 'fb' })
    expect(await attempts()).toBe(1)
    expect(await dueAt()).toBe(T + 3 * day + 1 * minute)
    await runDueJourneys(db, { now: new Date(T + 3 * day + 1 * minute) }) // fb throws (2): still not error, 5 minutes now
    expect(await run(runId)).toMatchObject({ status: 'active', node_id: 'fb' })
    expect(await attempts()).toBe(2)
    expect(await dueAt()).toBe(T + 3 * day + 6 * minute)
    await runDueJourneys(db, { now: new Date(T + 3 * day + 6 * minute) })
    expect(await run(runId)).toMatchObject({ status: 'done' })
    expect(await attempts()).toBe(0)
  })

  it('attempts reset on every committed success path: wait, exit (finish) and the end of the graph', async () => {
    const left: Record<string, number> = {}
    registerNodeHandler({
      kind: 'flaky_once_test',
      validate: () => [],
      run: async ({ run: r, node }) => {
        const k = `${r.id}:${node.id}`
        if (!(k in left)) {
          left[k] = 1
          throw new Error('first time fails')
        }
        return { type: 'next' }
      },
    })
    const graphs = {
      wait: { start: 'f', nodes: [{ id: 'f', kind: 'flaky_once_test', next: 'w' }, { id: 'w', kind: 'wait', config: { days: 1 } }] },
      exit: { start: 'f', nodes: [{ id: 'f', kind: 'flaky_once_test', next: 'x' }, { id: 'x', kind: 'exit' }] },
      end: { start: 'f', nodes: [{ id: 'f', kind: 'flaky_once_test' }] },
    }
    const want = { wait: 'waiting', exit: 'exited', end: 'done' } as const
    const T = Date.now() + 90 * day
    for (const kind of ['wait', 'exit', 'end'] as const) {
      const c = await addCompany(db, { name: `Attempts ${kind} Co`, domain: `attempts-${kind}.example` })
      const j = await runOp(db, 'owner', 'journey_upsert', { name: `Attempts ${kind}` }) as { id: number }
      await runOp(db, 'owner', 'journey_publish', { journey_id: j.id, graph: graphs[kind] })
      await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
      const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: c }) as { results: { run_id: number }[] }
      const id = en.results[0].run_id
      await runDueJourneys(db, { now: new Date(T) })
      expect((await db.query<{ attempts: number }>('select attempts from lp.journey_runs where id = $1', [id])).rows[0].attempts).toBe(1)
      await runDueJourneys(db, { now: new Date(T + 10 * minute) })
      expect((await run(id)).status).toBe(want[kind])
      expect((await db.query<{ attempts: number }>('select attempts from lp.journey_runs where id = $1', [id])).rows[0].attempts).toBe(0)
    }
  })

  it('a node that fails after an earlier node succeeded rolls back only itself: the earlier node is not repeated, and the retry keeps its idempotency key', async () => {
    let effects = 0
    const keys: string[] = []
    let bFails = 1
    registerNodeHandler({ kind: 'effect_test', validate: () => [], run: async () => { effects++; return { type: 'next' } } })
    registerNodeHandler({
      kind: 'then_boom_test',
      validate: () => [],
      run: async ({ idempotencyKey }) => {
        keys.push(idempotencyKey)
        if (bFails-- > 0) throw new Error('b failed once')
        return { type: 'next' }
      },
    })
    const c = await addCompany(db, { name: 'Commit Co', domain: 'commit.example' })
    const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Per node commit' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', {
      journey_id: j.id, graph: { start: 'a', nodes: [{ id: 'a', kind: 'effect_test', next: 'b' }, { id: 'b', kind: 'then_boom_test' }] },
    })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: c }) as { results: { run_id: number }[] }
    const id = en.results[0].run_id
    const T = Date.now() + 100 * day
    await runDueJourneys(db, { now: new Date(T) })
    expect(effects).toBe(1)
    expect(await run(id)).toMatchObject({ status: 'active', node_id: 'b', last_error: 'b failed once' }) // parked ON b, a stays done
    await runDueJourneys(db, { now: new Date(T + 2 * minute) })
    expect(await run(id)).toMatchObject({ status: 'done' })
    expect(effects).toBe(1)
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
    expect(keys[0]).toMatch(new RegExp(`^journey-run:${id}:b:`))
    const log = await runOp(db, 'owner', 'journey_run_log', { run_id: id }) as { steps: { node_id: string; action: string }[] }
    expect(log.steps.map((x) => `${x.node_id}:${x.action}`)).toEqual(['a:entered', 'a:effect_test', 'b:retry', 'b:then_boom_test'])
  })

  it('the idempotency key is new on every visit, even an instant loop back to a node in one tick, and the same on a retry of one visit', async () => {
    const keys: string[] = []
    let calls = 0
    let failSecondVisitOnce = true
    registerNodeHandler({
      kind: 'loop_key_test',
      validate: () => [],
      run: async ({ idempotencyKey }) => {
        keys.push(idempotencyKey)
        calls++
        if (calls === 2 && failSecondVisitOnce) {
          failSecondVisitOnce = false
          throw new Error('second visit fails once')
        }
        return calls >= 3 ? { type: 'finish', status: 'done' } : { type: 'next' }
      },
    })
    const c = await addCompany(db, { name: 'Loop Co', domain: 'loop.example' })
    const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Instant loop' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', {
      journey_id: j.id, graph: { start: 'a', nodes: [{ id: 'a', kind: 'loop_key_test', next: 'b' }, { id: 'b', kind: 'note', next: 'a' }] },
    })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: c }) as { results: { run_id: number }[] }
    const id = en.results[0].run_id
    const T = Date.now() + 110 * day
    // One tick: visit 1 of A -> B -> visit 2 of A (throws). Same `now` throughout, yet different keys.
    await runDueJourneys(db, { now: new Date(T) })
    expect(await run(id)).toMatchObject({ status: 'active', node_id: 'a', last_error: 'second visit fails once' })
    expect(keys).toHaveLength(2)
    expect(keys[0]).not.toBe(keys[1])
    expect(keys.map((k) => k.replace(/^journey-run:\d+:/, ''))).toEqual(['a:1', 'a:3'])
    // The retry of visit 2 reuses its key (the failed node committed nothing); visit 3 is new.
    await runDueJourneys(db, { now: new Date(T + minute) })
    expect(await run(id)).toMatchObject({ status: 'done' })
    expect(keys).toHaveLength(3)
    expect(keys[2]).toBe(keys[1])
  })

  it('resuming a paused journey moves its waits forward by exactly the pause; fires from the pause are not replayed', async () => {
    const trig = await runOp(db, 'owner', 'upsert_trigger', { name: 'Resume (journey)', kind: 'event', config: { event_type: 'custom' } }) as { id: number }
    const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Pausable', trigger_id: trig.id, entry_mode: 'multiple' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', { journey_id: j.id, graph: { start: 'w', nodes: [{ id: 'w', kind: 'wait', config: { days: 3 } }] } })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co }) as { results: { run_id: number }[] }
    const runId = en.results[0].run_id
    await runDueJourneys(db)
    const dueAt = async () => new Date((await run(runId)).next_run_at as Date).getTime()
    const before = await dueAt()

    // The clock is injected, so the shift is exact: paused at P, paused again at P+1d (the pause
    // does not restart), resumed at P+2d.
    const P = new Date(Date.UTC(2031, 0, 10, 12, 0, 0))
    await setJourneyStatus(db, 'owner', j.id, 'paused', 'ops_api', P)
    await emitLeadEvent(db, { type: 'custom', company_id: co2, source: 'test' }) // fired while paused
    await setJourneyStatus(db, 'owner', j.id, 'paused', 'ops_api', new Date(P.getTime() + day))
    expect(new Date((await db.query<{ paused_at: Date }>('select paused_at from lp.journeys where id = $1', [j.id])).rows[0].paused_at).getTime()).toBe(P.getTime())
    expect(await dueAt()).toBe(before) // nothing moves while paused
    await setJourneyStatus(db, 'owner', j.id, 'live', 'ops_api', new Date(P.getTime() + 2 * day))
    expect(await dueAt()).toBe(before + 2 * day)
    expect((await db.query<{ paused_at: Date | null }>('select paused_at from lp.journeys where id = $1', [j.id])).rows[0].paused_at).toBeNull()
    // Other live journeys in this file share the 'custom' event and may enrol from it, so the check is on THIS journey.
    await runDueJourneys(db)
    const mine = await db.query<{ company_id: number; source: string }>('select company_id, source from lp.journey_runs where journey_id = $1', [j.id])
    expect(mine.rows).toEqual([{ company_id: co, source: 'manual' }]) // the fire from the pause did not enrol co2
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
    const c = await addCompany(db, { name: 'Budget Co', domain: 'budget.example' })
    const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Budget' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', { journey_id: j.id, graph: { start: 'n', nodes: [{ id: 'n', kind: 'note' }] } })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: c }) as { results: { run_id: number }[] }
    const T = new Date(Date.now() + 80 * day)
    const spent = await runDueJourneys(db, { now: T, budgetMs: 0 })
    expect(spent.due).toBeGreaterThanOrEqual(1)
    expect(spent).toMatchObject({ advanced: 0, deadline_reached: true })
    expect((await run(en.results[0].run_id)).status).toBe('active') // untouched
    const next = await runDueJourneys(db, { now: T })
    expect(next.deadline_reached).toBe(false)
    expect((await run(en.results[0].run_id)).status).toBe('done')
  })

  it('segment enrolment pages by company id in SQL: more leads than a page, no skip, no repeat, and a lead added mid-way is not missed', async () => {
    const ids: number[] = []
    for (let i = 0; i < 7; i++) ids.push(await addCompany(db, { name: `Pager ${i}`, city: 'Pagerville', domain: `pager${i}.example` }))
    const seg = await runOp(db, 'owner', 'create_segment', {
      name: 'Pagerville', entity: 'company',
      definition: { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.city', op: 'is', value: 'Pagerville' }] }] },
    }) as { id: number }
    const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Paged', entry_mode: 'multiple' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', { journey_id: j.id, graph: { start: 'w', nodes: [{ id: 'w', kind: 'wait', config: { days: 1 } }] } })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    type Page = { enrolled: number; more: boolean; next_after_company_id: number | null; results: { company_id: number }[] }
    const seen: number[] = []
    let after: number | null = null
    let pages = 0
    let late = 0
    for (;;) {
      const r = await runOp(db, 'owner', 'journey_enroll', {
        journey_id: j.id, segment_id: seg.id, page_size: 3, ...(after == null ? {} : { after_company_id: after }),
      }) as Page
      pages++
      expect(r.results.length).toBeLessThanOrEqual(3)
      seen.push(...r.results.map((x) => x.company_id))
      if (pages === 1) late = await addCompany(db, { name: 'Pager late', city: 'Pagerville', domain: 'pagerlate.example' }) // sorts after every page-1 id
      if (!r.more) break
      expect(r.next_after_company_id).toBe(r.results[r.results.length - 1].company_id)
      after = r.next_after_company_id
    }
    expect(pages).toBe(3) // 8 leads in pages of 3, 3, 2
    expect(seen).toEqual([...ids, late]) // ascending, each exactly once, nothing skipped
    expect(new Set(seen).size).toBe(seen.length)
    const { rows } = await db.query<{ n: number }>('select count(*)::int as n from lp.journey_runs where journey_id = $1', [j.id])
    expect(rows[0].n).toBe(8)
    // The page is capped, and an out-of-range page_size is refused.
    await expect(runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, segment_id: seg.id, page_size: 5000 })).rejects.toMatchObject({ status: 400 })

    // A contact-entity segment maps to each company once, however many of its contacts match.
    const cc = await addCompany(db, { name: 'Pager contacts', city: 'Contactville', domain: 'pagercontacts.example' })
    for (const e of ['a', 'b']) {
      const ct = await addContact(db, cc, `${e}@pagercontacts.example`)
      await db.query(`update lp.contacts set title = 'Pager Title' where id = $1`, [ct])
    }
    const cseg = await runOp(db, 'owner', 'create_segment', {
      name: 'Pager title', entity: 'contact',
      definition: { entity: 'contact', include: [{ conditions: [{ kind: 'field', field: 'contact.title', op: 'is', value: 'Pager Title' }] }] },
    }) as { id: number }
    const cr = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, segment_id: cseg.id, page_size: 1 }) as Page
    expect(cr.results.map((x) => x.company_id)).toEqual([cc])
    expect(cr.more).toBe(false)
  })

  it('company-level domain suppression blocks enrolment and a run already waiting', async () => {
    const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Domain block', entry_mode: 'multiple' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', { journey_id: j.id, graph: { start: 'w', nodes: [{ id: 'w', kind: 'wait', config: { days: 5 } }] } })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const enrol = async (body: Record<string, unknown>) =>
      (await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, ...body }) as { enrolled: number; results: { reason?: string; run_id: number }[] })

    // 1. The company's own website domain, no contact involved.
    const site = await addCompany(db, { name: 'Rival Co', domain: 'rival.example' })
    const sup = await db.tx((q) => addSuppressionIn(q, null, { domain: 'rival.example', reason: 'competitor' }))
    expect((await enrol({ company_id: site })).results[0]).toMatchObject({ enrolled: false, reason: 'suppressed' })
    // 2. A domain only its contacts' emails use (the website is somewhere else).
    const mail = await addCompany(db, { name: 'Mail Co', domain: 'mailco.example' })
    await addContact(db, mail, 'pat@mailhost.example')
    await db.tx((q) => addSuppressionIn(q, null, { domain: 'mailhost.example', reason: 'customer' }))
    expect((await enrol({ company_id: mail })).results[0]).toMatchObject({ enrolled: false, reason: 'suppressed' })
    // 3. A company on neither domain still enters; lifting the suppression lets the first one in.
    const fine = await addCompany(db, { name: 'Fine Co', domain: 'fine.example' })
    expect((await enrol({ company_id: fine })).enrolled).toBe(1)
    await db.query('update lp.suppressions set lifted_at = now() where id = $1', [sup.row.id])
    expect((await enrol({ company_id: site })).enrolled).toBe(1)
    // 4. Suppressing the domain later ends the run that is already waiting, on its next tick.
    const runId = (await db.query<{ id: number }>('select id from lp.journey_runs where journey_id = $1 and company_id = $2', [j.id, site])).rows[0].id
    await runDueJourneys(db, { now: new Date(Date.now() + 1000) })
    expect((await run(runId)).status).toBe('waiting')
    await db.tx((q) => addSuppressionIn(q, null, { domain: 'rival.example', reason: 'legal' }))
    await runDueJourneys(db, { now: new Date(Date.now() + 6 * day) })
    expect((await run(runId)).status).toBe('exited')
    const log = await runOp(db, 'owner', 'journey_run_log', { run_id: runId }) as { steps: { action: string; result: { reason?: string } }[] }
    expect(log.steps.find((x) => x.action === 'exited_suppressed')?.result).toEqual({ reason: 'suppressed' })
  })

  it("entry once vs multiple is judged at the run's grain: a company-level run covers its contacts, and the reverse", async () => {
    const mk = async (name: string, entry_mode: string) => {
      const j = await runOp(db, 'owner', 'journey_upsert', { name, entry_mode }) as { id: number }
      await runOp(db, 'owner', 'journey_publish', { journey_id: j.id, graph: { start: 'w', nodes: [{ id: 'w', kind: 'wait', config: { days: 5 } }] } })
      await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
      return j.id
    }
    const enrol = async (journey_id: number, body: Record<string, unknown>) =>
      (await runOp(db, 'owner', 'journey_enroll', { journey_id, ...body }) as { enrolled: number; results: { reason?: string; run_id: number }[] }).results[0]
    const c1 = await addCompany(db, { name: 'Grain One', domain: 'grain1.example' })
    const c2 = await addCompany(db, { name: 'Grain Two', domain: 'grain2.example' })
    const [p1, p2] = [await addContact(db, c1, 'p1@grain1.example'), await addContact(db, c1, 'p2@grain1.example')]
    const q1 = await addContact(db, c2, 'q1@grain2.example')

    const once = await mk('Grain once', 'once')
    expect(await enrol(once, { company_id: c1 })).toMatchObject({ run_id: expect.any(Number) })
    expect(await enrol(once, { contact_id: p1 })).toMatchObject({ reason: 'already_entered' }) // company-level run covers its contacts
    expect(await enrol(once, { contact_id: q1 })).toMatchObject({ run_id: expect.any(Number) }) // another company is unaffected
    expect(await enrol(once, { contact_id: q1 })).toMatchObject({ reason: 'already_entered' })
    expect(await enrol(once, { company_id: c2 })).toMatchObject({ reason: 'already_entered' }) // a contact run covers the company

    const multi = await mk('Grain multi', 'multiple')
    expect((await enrol(multi, { contact_id: p1 })).run_id).toEqual(expect.any(Number))
    expect((await enrol(multi, { contact_id: p2 })).run_id).toEqual(expect.any(Number)) // two contacts of one company can both be in
    expect(await enrol(multi, { company_id: c1 })).toMatchObject({ reason: 'already_in' }) // but not the whole company on top
    expect(await enrol(multi, { contact_id: p1 })).toMatchObject({ reason: 'already_in' })
    await runOp(db, 'owner', 'journey_exit', { journey_id: multi, contact_id: p1 })
    await runOp(db, 'owner', 'journey_exit', { journey_id: multi, contact_id: p2 })
    expect((await enrol(multi, { company_id: c1 })).run_id).toEqual(expect.any(Number)) // once nothing is open it can enter again
    expect(await enrol(multi, { contact_id: p2 })).toMatchObject({ reason: 'already_in' })
  })

  describe('bad rows and bad data', () => {
    beforeAll(async () => {
      // A company named 'Poison Co' makes the run insert fail with a data error (class 23, the same every time);
      // 'Flaky Poison Co' fails with a plain error (could be transient), so it must NOT be skipped.
      await db.query(`
        create or replace function lp.test_poison() returns trigger language plpgsql as $$
        declare n text;
        begin
          select name into n from lp.companies where id = new.company_id;
          if n = 'Poison Co' then raise exception 'poisoned row' using errcode = '23514'; end if;
          if n = 'Flaky Poison Co' then raise exception 'flaky database'; end if;
          return new;
        end $$`)
      await db.query('create trigger test_poison before insert on lp.journey_runs for each row execute function lp.test_poison()')
    })
    afterAll(async () => {
      await db.query('drop trigger if exists test_poison on lp.journey_runs')
    })

    async function liveJourney(name: string, trigger_id: number | null) {
      const j = await runOp(db, 'owner', 'journey_upsert', { name, entry_mode: 'multiple', ...(trigger_id ? { trigger_id } : {}) }) as { id: number }
      await runOp(db, 'owner', 'journey_publish', { journey_id: j.id, graph: { start: 'w', nodes: [{ id: 'w', kind: 'wait', config: { days: 1 } }] } })
      await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
      return j.id
    }
    const fire = async (trigger_id: number, company_id: number) =>
      (await db.query<{ id: number }>('insert into lp.trigger_fires (trigger_id, company_id) values ($1, $2) returning id', [trigger_id, company_id])).rows[0].id

    it('a fire the database rejects is skipped and reported; the cursor moves on and the fires around it enrol', async () => {
      const trig = await runOp(db, 'owner', 'upsert_trigger', { name: 'Poison (journey)', kind: 'event', config: { event_type: 'custom' } }) as { id: number }
      const jid = await liveJourney('Poison fires', trig.id)
      const good1 = await addCompany(db, { name: 'Good One', domain: 'good1.example' })
      const bad = await addCompany(db, { name: 'Poison Co', domain: 'poison.example' })
      const good2 = await addCompany(db, { name: 'Good Two', domain: 'good2.example' })
      const badFire = await fire(trig.id, bad)
      await fire(trig.id, good1)
      await fire(trig.id, good2)
      const t = await runDueJourneys(db)
      expect(t).toMatchObject({ enrolled_from_triggers: 2, skipped_fires: 1, trigger_errors: 0 })
      const { rows } = await db.query<{ company_id: number }>('select company_id from lp.journey_runs where journey_id = $1 order by company_id', [jid])
      expect(rows.map((r) => r.company_id)).toEqual([good1, good2])
      const cur = (await db.query<{ trigger_cursor: number }>('select trigger_cursor from lp.journeys where id = $1', [jid])).rows[0].trigger_cursor
      expect(cur).toBeGreaterThan(badFire) // the cursor is past the poison fire
      expect(await runDueJourneys(db)).toMatchObject({ enrolled_from_triggers: 0, skipped_fires: 0 }) // and it is not read again
    })

    it('a failure that may be transient holds the journey cursor for retry, without stopping other journeys or the due runs', async () => {
      const tA = await runOp(db, 'owner', 'upsert_trigger', { name: 'Flaky A (journey)', kind: 'event', config: { event_type: 'custom' } }) as { id: number }
      const tB = await runOp(db, 'owner', 'upsert_trigger', { name: 'Flaky B (journey)', kind: 'event', config: { event_type: 'custom' } }) as { id: number }
      const ja = await liveJourney('Flaky A', tA.id)
      const jb = await liveJourney('Flaky B', tB.id)
      const flaky = await addCompany(db, { name: 'Flaky Poison Co', domain: 'flakypoison.example' })
      const fine = await addCompany(db, { name: 'Fine Fire Co', domain: 'finefire.example' })
      // A due run elsewhere must still advance in the same tick.
      const jn = await runOp(db, 'owner', 'journey_upsert', { name: 'Due anyway' }) as { id: number }
      await runOp(db, 'owner', 'journey_publish', { journey_id: jn.id, graph: { start: 'n', nodes: [{ id: 'n', kind: 'note' }] } })
      await runOp(db, 'owner', 'journey_set_status', { journey_id: jn.id, status: 'live' })
      const due = await runOp(db, 'owner', 'journey_enroll', { journey_id: jn.id, company_id: fine }) as { results: { run_id: number }[] }
      const fa = await fire(tA.id, flaky)
      await fire(tB.id, fine)
      const t = await runDueJourneys(db, { now: new Date(Date.now() + 1000) })
      expect(t.trigger_errors).toBe(1)
      expect(t.trigger_failures).toEqual([{ journey_id: ja, error: expect.stringMatching(/flaky database/) }])
      expect(t.enrolled_from_triggers).toBe(1) // journey B
      expect((await db.query('select 1 from lp.journey_runs where journey_id = $1', [jb])).rows).toHaveLength(1)
      expect((await run(due.results[0].run_id)).status).toBe('done') // the run behind the failing read still advanced
      const cur = (await db.query<{ trigger_cursor: number }>('select trigger_cursor from lp.journeys where id = $1', [ja])).rows[0].trigger_cursor
      expect(cur).toBeLessThan(fa) // not skipped: it is retried on the next tick
    })

    it('fires of a disabled trigger enrol nobody, are skipped past the cursor, and are not replayed on re-enable', async () => {
      const trig = await runOp(db, 'owner', 'upsert_trigger', { name: 'Disabled (journey)', kind: 'event', config: { event_type: 'custom' } }) as { id: number }
      const jid = await liveJourney('Disabled trigger', trig.id)
      const c1 = await addCompany(db, { name: 'Disabled One', domain: 'dis1.example' })
      const c2 = await addCompany(db, { name: 'Disabled Two', domain: 'dis2.example' })
      const c3 = await addCompany(db, { name: 'Disabled Three', domain: 'dis3.example' })
      const f1 = await fire(trig.id, c1) // written while enabled, but still unread when the trigger is disabled
      await db.query('update lp.triggers set enabled = false where id = $1', [trig.id])
      const f2 = await fire(trig.id, c2)
      const t = await runDueJourneys(db)
      expect(t).toMatchObject({ enrolled_from_triggers: 0, skipped_fires: 2 })
      expect((await db.query('select 1 from lp.journey_runs where journey_id = $1', [jid])).rows).toHaveLength(0)
      const cursor = async () => (await db.query<{ trigger_cursor: number }>('select trigger_cursor from lp.journeys where id = $1', [jid])).rows[0].trigger_cursor
      expect(await cursor()).toBe(f2) // past both, so neither comes back
      await db.query('update lp.triggers set enabled = true where id = $1', [trig.id])
      expect(await runDueJourneys(db)).toMatchObject({ enrolled_from_triggers: 0, skipped_fires: 0 })
      await fire(trig.id, c3)
      expect(await runDueJourneys(db)).toMatchObject({ enrolled_from_triggers: 1 })
      const { rows } = await db.query<{ company_id: number }>('select company_id from lp.journey_runs where journey_id = $1', [jid])
      expect(rows.map((r) => r.company_id)).toEqual([c3])
      expect(f1).toBeLessThan(f2)
    })

    it('journey_enroll reports a lead the database rejects as an error and still enrols the rest', async () => {
      const jid = await liveJourney('Enrol poison', null)
      const g1 = await addCompany(db, { name: 'Enrol Good 1', domain: 'eg1.example' })
      const bad = await addCompany(db, { name: 'Poison Co', domain: 'poison2.example' })
      const g2 = await addCompany(db, { name: 'Enrol Good 2', domain: 'eg2.example' })
      const r = await runOp(db, 'owner', 'journey_enroll', { journey_id: jid, company_ids: [g1, bad, g2] }) as {
        enrolled: number; failed: number; results: { company_id: number; reason?: string; error?: string }[]
      }
      expect(r).toMatchObject({ enrolled: 2, failed: 1 })
      expect(r.results[1]).toMatchObject({ company_id: bad, reason: 'error', error: expect.stringMatching(/poisoned row/) })
      const { rows } = await db.query<{ company_id: number }>('select company_id from lp.journey_runs where journey_id = $1 order by company_id', [jid])
      expect(rows.map((x) => x.company_id)).toEqual([g1, g2])
    })
  })

  it('source: only manual and api are accepted from a caller, and each is stored as given', async () => {
    const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Sources', entry_mode: 'multiple' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', { journey_id: j.id, graph: { start: 'w', nodes: [{ id: 'w', kind: 'wait', config: { days: 1 } }] } })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const a = await addCompany(db, { name: 'Source A', domain: 'sa.example' })
    const b = await addCompany(db, { name: 'Source B', domain: 'sb.example' })
    for (const bad of ['trigger', 'segment', 'bogus', 'API']) {
      await expect(runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: a, source: bad })).rejects.toMatchObject({ status: 400 })
    }
    await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: a })
    await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: b, source: 'api' })
    const { rows } = await db.query<{ company_id: number; source: string }>('select company_id, source from lp.journey_runs where journey_id = $1 order by company_id', [j.id])
    expect(rows).toEqual([{ company_id: a, source: 'manual' }, { company_id: b, source: 'api' }])
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
