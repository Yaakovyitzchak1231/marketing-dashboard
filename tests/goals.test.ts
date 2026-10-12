import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { emitLeadEvent } from '@/lib/events/emit'
import { runOp } from '@/lib/ops/dispatch'
import { advanceRun, applyExitCriteria, enrollLead, runDueJourneys } from '@/lib/journeys/runner'
import { GraphError, validateGraph } from '@/lib/journeys/graph'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('goals, go-to, exit, entry cap (plan 3.7)', () => {
  let db: TestDb

  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => db.close())

  async function company(name: string, domain: string) {
    return addCompany(db, { name, domain, city: 'Towson' })
  }

  async function statusOf(runId: number) {
    const { rows } = await db.query<{ status: string; node_id: string }>(
      'select status, node_id from lp.journey_runs where id = $1',
      [runId],
    )
    return rows[0]
  }

  it('a goal node finishes the run as goal', async () => {
    const co = await company('Goal Co', 'goal.example')
    const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Goal' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', {
      journey_id: j.id,
      graph: { start: 'win', nodes: [{ id: 'win', kind: 'goal' }] },
    })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co }) as { results: { run_id: number }[] }
    await runDueJourneys(db)
    expect(await statusOf(en.results[0].run_id)).toMatchObject({ status: 'goal', node_id: 'win' })
  })

  it('goto jumps to the named node', async () => {
    const co = await company('Jump Co', 'jump.example')
    const j = await runOp(db, 'owner', 'journey_upsert', { name: 'Jump' }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', {
      journey_id: j.id,
      graph: {
        start: 'hop',
        nodes: [
          { id: 'hop', kind: 'goto', config: { to: 'landed' } },
          { id: 'landed', kind: 'note' },
        ],
      },
    })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co }) as { results: { run_id: number }[] }
    await runDueJourneys(db)
    expect(await statusOf(en.results[0].run_id)).toMatchObject({ status: 'done', node_id: 'landed' })
  })

  it('exit_event on the journey goal takes the run out', async () => {
    const co = await company('Exit Co', 'exit.example')
    const j = await runOp(db, 'owner', 'journey_upsert', {
      name: 'Exit if unsubscribed', goal: { exit_event: 'lead_unsubscribed' },
    }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', {
      journey_id: j.id,
      graph: { start: 'hold', nodes: [{ id: 'hold', kind: 'wait', config: { days: 3 } }] },
    })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co }) as { results: { run_id: number }[] }
    const runId = en.results[0].run_id
    await runDueJourneys(db)
    await emitLeadEvent(db, { type: 'lead_unsubscribed', company_id: co, source: 'test' })
    await runDueJourneys(db, { now: new Date(Date.now() + 60_000) })
    expect((await statusOf(runId)).status).toBe('exited')
  })

  it('entry_cap blocks another pass after the cap', async () => {
    const co = await company('Cap Co', 'cap.example')
    const j = await runOp(db, 'owner', 'journey_upsert', {
      name: 'Twice', entry_mode: 'multiple', settings: { entry_cap: 2 },
    }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', {
      journey_id: j.id,
      graph: { start: 'n', nodes: [{ id: 'n', kind: 'exit', config: { reason: 'done' } }] },
    })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    const first = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co }) as { enrolled: number }
    await runDueJourneys(db)
    const second = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co }) as { enrolled: number }
    await runDueJourneys(db)
    const third = await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: co }) as { enrolled: number; results: { reason?: string }[] }
    expect(first.enrolled).toBe(1)
    expect(second.enrolled).toBe(1)
    expect(third.enrolled).toBe(0)
  })

  async function liveJourney(name: string, graph: unknown, extra: Record<string, unknown> = {}) {
    const j = await runOp(db, 'owner', 'journey_upsert', { name, ...extra }) as { id: number }
    await runOp(db, 'owner', 'journey_publish', { journey_id: j.id, graph })
    await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
    return j.id
  }

  it('goto trims its target when validated and when run', async () => {
    const g = validateGraph({
      start: 'hop',
      nodes: [{ id: 'hop', kind: 'goto', config: { to: ' landed ' } }, { id: 'landed', kind: 'note' }],
    })
    expect(g.nodes.find((n) => n.id === 'hop')?.config.to).toBe('landed')

    // A version published before normalisation may hold a padded id: run() must trim too.
    const co = await company('Pad Co', 'pad.example')
    const jid = await liveJourney('Padded', {
      start: 'hop',
      nodes: [{ id: 'hop', kind: 'goto', config: { to: 'landed' } }, { id: 'landed', kind: 'note' }],
    })
    await db.query(
      `update lp.journey_versions set graph = jsonb_set(graph, '{nodes,0,config,to}', '" landed "') where journey_id = $1`,
      [jid],
    )
    const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: jid, company_id: co }) as { results: { run_id: number }[] }
    await runDueJourneys(db)
    expect(await statusOf(en.results[0].run_id)).toMatchObject({ status: 'done', node_id: 'landed' })
  })

  it('validateGraph rejects a goto to a node that does not exist', () => {
    const bad = { start: 'hop', nodes: [{ id: 'hop', kind: 'goto', config: { to: 'nowhere' } }] }
    expect(() => validateGraph(bad)).toThrow(GraphError)
    try {
      validateGraph(bad)
    } catch (e) {
      expect((e as GraphError).errors).toContain("node 'hop' points at unknown node 'nowhere'")
    }
    expect(() => validateGraph({ start: 'hop', nodes: [{ id: 'hop', kind: 'goto', config: {} }] })).toThrow(/goto needs config.to/)
  })

  it('exit criteria: one bounded set-based pass over many runs, scoped to the run and by occurred_at', async () => {
    const jid = await liveJourney(
      'Exit many',
      { start: 'hold', nodes: [{ id: 'hold', kind: 'wait', config: { days: 5 } }] },
      { goal: { exit_event: 'lead_unsubscribed' } },
    )
    const hit: number[] = []
    for (let i = 0; i < 12; i++) hit.push(await company(`Many ${i}`, `many${i}.example`))
    const quiet = await company('Quiet Co', 'quiet.example')
    const early = await company('Early Co', 'early.example')
    const withContact = await company('Contact Co', 'contactco.example')
    const contact = await addContact(db, withContact, 'p@contactco.example')
    const contactRun = await runOp(db, 'owner', 'journey_enroll', { journey_id: jid, contact_id: contact }) as { results: { run_id: number }[] }
    // An event from before the run entered does not count (occurred_at window).
    await emitLeadEvent(db, { type: 'lead_unsubscribed', company_id: early, source: 'test', occurred_at: new Date(Date.now() - 3600_000) })
    const runs: Record<number, number> = {}
    for (const c of [...hit, quiet, early]) {
      const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: jid, company_id: c }) as { results: { run_id: number }[] }
      runs[c] = en.results[0].run_id
    }
    for (const c of hit) await emitLeadEvent(db, { type: 'lead_unsubscribed', company_id: c, source: 'test' })
    // A company-level event does not exit a run that belongs to a contact.
    await emitLeadEvent(db, { type: 'lead_unsubscribed', company_id: withContact, source: 'test' })

    const first = await applyExitCriteria(db, new Date(), 'system', 5)
    expect(first).toBe(5)
    const second = await applyExitCriteria(db, new Date(), 'system', 500)
    expect(second).toBe(7)
    expect(await applyExitCriteria(db, new Date(), 'system', 500)).toBe(0)
    for (const c of hit) expect((await statusOf(runs[c])).status).toBe('exited')
    expect((await statusOf(runs[quiet])).status).not.toBe('exited')
    expect((await statusOf(runs[early])).status).not.toBe('exited')
    expect((await statusOf(contactRun.results[0].run_id)).status).not.toBe('exited')

    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from lp.journey_steps_log where journey_id = $1 and action = 'exit_criteria'`, [jid])
    expect(rows[0].n).toBe(12)
  })

  it('entry_cap counts all-time entries per lead, open or finished', async () => {
    const co = await company('Cap Doc Co', 'capdoc.example')
    const other = await company('Cap Other Co', 'capother.example')
    const jid = await liveJourney(
      'Cap one', { start: 'n', nodes: [{ id: 'n', kind: 'exit' }] },
      { entry_mode: 'multiple', settings: { entry_cap: 1 } },
    )
    const a = await db.tx((q) => enrollLead(q, 'owner', jid, { company_id: co }))
    await runDueJourneys(db)
    const b = await db.tx((q) => enrollLead(q, 'owner', jid, { company_id: co }))
    const c = await db.tx((q) => enrollLead(q, 'owner', jid, { company_id: other }))
    expect(a.enrolled).toBe(true)
    expect(b).toMatchObject({ enrolled: false, reason: 'already_entered' })
    expect(c.enrolled).toBe(true)
  })

  it('entry_cap: two parallel enrols at cap - 1 let exactly one in', async () => {
    const co = await company('Race Co', 'race.example')
    const jid = await liveJourney(
      'Cap race', { start: 'n', nodes: [{ id: 'n', kind: 'exit' }] },
      { entry_mode: 'multiple', settings: { entry_cap: 2 } },
    )
    await db.tx((q) => enrollLead(q, 'owner', jid, { company_id: co }))
    await runDueJourneys(db)
    const results = await Promise.all([
      db.tx((q) => enrollLead(q, 'owner', jid, { company_id: co })),
      db.tx((q) => enrollLead(q, 'owner', jid, { company_id: co })),
    ])
    expect(results.filter((r) => r.enrolled)).toHaveLength(1)
    const { rows } = await db.query<{ n: number }>('select count(*)::int as n from lp.journey_runs where journey_id = $1', [jid])
    expect(rows[0].n).toBe(2)
  })

  it('enrolLead takes a per-journey advisory lock before it counts', async () => {
    const co = await company('Lock Co', 'lock.example')
    const jid = await liveJourney(
      'Lock', { start: 'n', nodes: [{ id: 'n', kind: 'exit' }] },
      { entry_mode: 'multiple', settings: { entry_cap: 3 } },
    )
    const held = await db.tx(async (q) => {
      await enrollLead(q, 'owner', jid, { company_id: co })
      const r = await q.query<{ n: number }>(`select count(*)::int as n from pg_locks where locktype = 'advisory' and granted`)
      return r.rows[0].n
    })
    expect(held).toBeGreaterThanOrEqual(1)
    const after = await db.query<{ n: number }>(`select count(*)::int as n from pg_locks where locktype = 'advisory'`)
    expect(after.rows[0].n).toBe(0)
  })

  it('entry_cap is judged at the run grain: a company-level run counts for its contacts', async () => {
    const co = await company('Grain Co', 'grain.example')
    const ct = await addContact(db, co, 'g@grain.example')
    const jid = await liveJourney(
      'Cap grain', { start: 'n', nodes: [{ id: 'n', kind: 'exit' }] },
      { entry_mode: 'multiple', settings: { entry_cap: 1 } },
    )
    const a = await db.tx((q) => enrollLead(q, 'owner', jid, { company_id: co }))
    await runDueJourneys(db)
    const b = await db.tx((q) => enrollLead(q, 'owner', jid, { contact_id: ct }))
    expect(a.enrolled).toBe(true)
    expect(b).toMatchObject({ enrolled: false, reason: 'already_entered' })
  })

  it('a tick reports exits by criteria, and advanceRun leaves a run between nodes', async () => {
    const co = await company('Tick Exit Co', 'tickexit.example')
    const jid = await liveJourney(
      'Tick exit',
      { start: 'a', nodes: [{ id: 'a', kind: 'note', next: 'b' }, { id: 'b', kind: 'wait', config: { days: 1 } }] },
      { goal: { exit_event: 'lead_unsubscribed' } },
    )
    const en = await runOp(db, 'owner', 'journey_enroll', { journey_id: jid, company_id: co }) as { results: { run_id: number }[] }
    await emitLeadEvent(db, { type: 'lead_unsubscribed', company_id: co, source: 'test' })
    // Direct advance: the in-chain check exits it before node a runs.
    const adv = await advanceRun(db, en.results[0].run_id)
    expect(adv).toMatchObject({ advanced: true, status: 'exited' })

    const co2 = await company('Tick Exit Two', 'tickexit2.example')
    const en2 = await runOp(db, 'owner', 'journey_enroll', { journey_id: jid, company_id: co2 }) as { results: { run_id: number }[] }
    await runDueJourneys(db)
    expect((await statusOf(en2.results[0].run_id)).status).toBe('waiting')
    await emitLeadEvent(db, { type: 'lead_unsubscribed', company_id: co2, source: 'test' })
    const tick = await runDueJourneys(db, { now: new Date(Date.now() + 60_000) })
    expect(tick).toMatchObject({ exited_by_criteria: 1, exit_criteria_error: null })
    expect((await statusOf(en2.results[0].run_id)).status).toBe('exited')
  })
})
