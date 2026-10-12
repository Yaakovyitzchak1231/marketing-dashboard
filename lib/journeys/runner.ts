/**
 * Plan 3.1: the journey runner.
 *
 *  - enrollLead: put one lead (company and/or contact) into a journey at its start node.
 *  - exitRun:    take a run out by hand.
 *  - advanceRun: move one due run forward until it waits or ends (row-locked, SKIP LOCKED).
 *  - runDueJourneys: one tick — enrol from new trigger fires, then advance every due run.
 *    The `journey_tick` job calls it every minute through the run_journeys op.
 *
 * Every step is one row in lp.journey_steps_log. Entering and leaving are also
 * lead events (journey_entered / journey_finished), so the timeline and other
 * triggers see them.
 */
import type { Db, Queryable } from '../db/types.ts'
import { emitLeadEvent } from '../events/emit.ts'
import { findNode, type JourneyGraph } from './graph.ts'
import { getNodeHandler, type NodeOutcome, type RunState } from './nodes.ts'
import { JourneyError, getVersionGraph } from './store.ts'

/** Steps one run may take in a single advance, so a loop of instant nodes cannot spin forever. */
export const MAX_STEPS_PER_ADVANCE = 50
export const ENROLL_SOURCES = ['manual', 'segment', 'trigger', 'api'] as const
export type EnrollSource = (typeof ENROLL_SOURCES)[number]
const OPEN = `('active', 'waiting')`

export interface EnrollInput {
  company_id?: number | null
  contact_id?: number | null
  source?: EnrollSource
  context?: Record<string, unknown>
  trigger_fire_id?: number | null
  /** Allow enrolment while the journey is in testing (manual tries). Trigger fires never use it. */
  allow_testing?: boolean
}

export interface EnrollResult {
  enrolled: boolean
  run_id: number | null
  reason?: 'already_in' | 'already_entered' | 'duplicate_fire'
}

async function logStep(q: Queryable, run: { id: number; journey_id: number; version: number }, nodeId: string, action: string, result: Record<string, unknown>, actor: string | null): Promise<void> {
  await q.query(
    `insert into lp.journey_steps_log (run_id, journey_id, version, node_id, action, result, actor) values ($1, $2, $3, $4, $5, $6, $7)`,
    [run.id, run.journey_id, run.version, nodeId, action, JSON.stringify(result), actor],
  )
}

async function emit(q: Queryable, type: 'journey_entered' | 'journey_finished', run: { id: number; journey_id: number; version: number; company_id: number | null; contact_id: number | null }, campaignId: number | null, actor: string | null, props: Record<string, unknown>): Promise<void> {
  await emitLeadEvent(q, {
    type,
    company_id: run.company_id,
    contact_id: run.contact_id,
    campaign_id: campaignId,
    source: 'runner',
    actor,
    props: { journey_id: run.journey_id, run_id: run.id, version: run.version, ...props },
    dedupe_key: `${type}:${run.id}`,
  })
}

/** Resolve and check the lead: a contact fills in its company; both must exist. */
async function resolveLead(q: Queryable, companyId: number | null, contactId: number | null): Promise<{ company_id: number | null; contact_id: number | null }> {
  if (companyId == null && contactId == null) throw new JourneyError('give company_id or contact_id')
  if (contactId != null) {
    const { rows } = await q.query<{ company_id: number | null }>('select company_id from lp.contacts where id = $1', [contactId])
    if (!rows[0]) throw new JourneyError(`no contact ${contactId}`, 404)
    if (companyId != null && rows[0].company_id != null && Number(rows[0].company_id) !== companyId) {
      throw new JourneyError(`contact ${contactId} does not belong to company ${companyId}`)
    }
    return { company_id: companyId ?? (rows[0].company_id == null ? null : Number(rows[0].company_id)), contact_id: contactId }
  }
  const { rows } = await q.query('select 1 from lp.companies where id = $1', [companyId])
  if (!rows[0]) throw new JourneyError(`no company ${companyId}`, 404)
  return { company_id: companyId, contact_id: null }
}

/** Enrol one lead. Call inside a transaction (db.tx) — it writes the run, its first log row and an event. */
export async function enrollLead(q: Queryable, actor: string, journeyId: number, input: EnrollInput): Promise<EnrollResult> {
  const { rows: js } = await q.query<{ id: number; status: string; current_version: number | null; entry_mode: string; campaign_id: number | null }>(
    'select id, status, current_version, entry_mode, campaign_id from lp.journeys where id = $1',
    [journeyId],
  )
  const j = js[0]
  if (!j) throw new JourneyError('no journey with that id', 404)
  const okStatus = j.status === 'live' || (j.status === 'testing' && input.allow_testing)
  if (!okStatus) throw new JourneyError(`journey is ${j.status}; leads can enter only while it is live${input.allow_testing ? ' or testing' : ''}`, 409)
  if (j.current_version == null) throw new JourneyError('journey has no published version', 409)
  const graph = await getVersionGraph(q, journeyId, j.current_version)
  if (!graph) throw new JourneyError('journey version is missing', 500)
  const lead = await resolveLead(q, input.company_id ?? null, input.contact_id ?? null)
  const source = input.source ?? 'manual'
  if (!(ENROLL_SOURCES as readonly string[]).includes(source)) throw new JourneyError(`source must be one of: ${ENROLL_SOURCES.join(', ')}`)

  if (j.entry_mode === 'once') {
    const prior = await q.query(
      `select 1 from lp.journey_runs where journey_id = $1 and coalesce(company_id, 0) = coalesce($2::bigint, 0) and coalesce(contact_id, 0) = coalesce($3::bigint, 0) limit 1`,
      [journeyId, lead.company_id, lead.contact_id],
    )
    if (prior.rows[0]) return { enrolled: false, run_id: null, reason: 'already_entered' }
  }
  const { rows } = await q.query<{ id: number }>(
    `insert into lp.journey_runs (journey_id, version, company_id, contact_id, node_id, status, next_run_at, source, trigger_fire_id, context, created_by)
     values ($1, $2, $3, $4, $5, 'active', now(), $6, $7, $8, $9)
     on conflict do nothing
     returning id`,
    [journeyId, j.current_version, lead.company_id, lead.contact_id, graph.start, source, input.trigger_fire_id ?? null,
      JSON.stringify(input.context ?? {}), actor],
  )
  if (!rows[0]) {
    return { enrolled: false, run_id: null, reason: input.trigger_fire_id != null ? 'duplicate_fire' : 'already_in' }
  }
  const run = { id: Number(rows[0].id), journey_id: journeyId, version: j.current_version, ...lead }
  await logStep(q, run, graph.start, 'entered', { source, trigger_fire_id: input.trigger_fire_id ?? null }, actor)
  await emit(q, 'journey_entered', run, j.campaign_id, actor, { source })
  return { enrolled: true, run_id: run.id }
}

/** Take open runs out by hand: one run, or every open run for a lead in a journey. */
export async function exitRuns(
  db: Db, actor: string, sel: { run_id?: number | null; journey_id?: number | null; company_id?: number | null; contact_id?: number | null }, reason: string | null = null,
): Promise<{ exited: number[] }> {
  if (sel.run_id == null && (sel.journey_id == null || (sel.company_id == null && sel.contact_id == null))) {
    throw new JourneyError('give run_id, or journey_id with company_id or contact_id')
  }
  return db.tx(async (q) => {
    const { rows } = await q.query<{ id: number; journey_id: number; version: number; node_id: string; company_id: number | null; contact_id: number | null; campaign_id: number | null }>(
      `update lp.journey_runs r
          set status = 'exited', finished_at = now(), next_run_at = null
         from lp.journeys j
        where j.id = r.journey_id and r.status in ${OPEN}
          and ($1::bigint is null or r.id = $1)
          and ($2::bigint is null or r.journey_id = $2)
          and ($3::bigint is null or r.company_id = $3)
          and ($4::bigint is null or r.contact_id = $4)
        returning r.id, r.journey_id, r.version, r.node_id, r.company_id, r.contact_id, j.campaign_id`,
      [sel.run_id ?? null, sel.journey_id ?? null, sel.company_id ?? null, sel.contact_id ?? null],
    )
    for (const r of rows) {
      await logStep(q, r, r.node_id, 'exited_by_hand', reason ? { reason } : {}, actor)
      await emit(q, 'journey_finished', r, r.campaign_id, actor, { status: 'exited', by: 'hand' })
    }
    return { exited: rows.map((r) => Number(r.id)) }
  }, actor)
}

type RunRow = RunState & { status: string; campaign_id: number | null; journey_status: string }

export interface AdvanceResult {
  run_id: number
  advanced: boolean
  steps: number
  status?: string
  node_id?: string
  error?: string
}

/**
 * Advance one run, if it is due and nobody else holds it. Runs in its own
 * transaction; a handler that throws marks the run `error` (other runs carry on).
 */
export async function advanceRun(db: Db, runId: number, now: Date = new Date(), actor = 'system'): Promise<AdvanceResult> {
  const graphs = new Map<string, JourneyGraph | null>()
  try {
    return await db.tx(async (q) => {
      const { rows } = await q.query<RunRow>(
        `select r.id, r.journey_id, r.version, r.company_id, r.contact_id, r.node_id, r.node_entered_at, r.entered_at,
                r.context, r.status, j.campaign_id, j.status as journey_status
           from lp.journey_runs r join lp.journeys j on j.id = r.journey_id
          where r.id = $1 and r.status in ${OPEN} and r.next_run_at <= $2
            and j.status in ('live', 'testing', 'sunset')
          for update of r skip locked`,
        [runId, now.toISOString()],
      )
      const row = rows[0]
      if (!row) return { run_id: runId, advanced: false, steps: 0 }
      const run: RunState = {
        ...row,
        id: Number(row.id), journey_id: Number(row.journey_id), version: Number(row.version),
        company_id: row.company_id == null ? null : Number(row.company_id),
        contact_id: row.contact_id == null ? null : Number(row.contact_id),
        node_entered_at: new Date(row.node_entered_at), entered_at: new Date(row.entered_at),
        context: row.context ?? {},
      }
      const key = `${run.journey_id}:${run.version}`
      if (!graphs.has(key)) graphs.set(key, await getVersionGraph(q, run.journey_id, run.version))
      const graph = graphs.get(key)
      if (!graph) throw new Error(`version ${run.version} of journey ${run.journey_id} is missing`)

      let steps = 0
      for (;;) {
        if (steps >= MAX_STEPS_PER_ADVANCE) {
          // Not an error: park it and continue on the next tick (a long chain of instant nodes).
          await q.query(`update lp.journey_runs set status = 'active', next_run_at = $2, node_id = $3, node_entered_at = $4, context = $5 where id = $1`,
            [run.id, now.toISOString(), run.node_id, run.node_entered_at.toISOString(), JSON.stringify(run.context)])
          await logStep(q, run, run.node_id, 'step_limit', { steps }, actor)
          return { run_id: run.id, advanced: true, steps, status: 'active', node_id: run.node_id }
        }
        const node = findNode(graph, run.node_id)
        if (!node) throw new Error(`node '${run.node_id}' is not in version ${run.version}`)
        const handler = getNodeHandler(node.kind)
        if (!handler) throw new Error(`no handler for node kind '${node.kind}'`)
        const out: NodeOutcome = await handler.run({ q, run, node, graph, now })
        steps++
        if ('context' in out && out.context) run.context = { ...run.context, ...out.context }

        if (out.type === 'wait') {
          if (!(out.until instanceof Date) || Number.isNaN(out.until.getTime())) throw new Error(`node '${node.id}' returned a bad wait time`)
          await q.query(
            `update lp.journey_runs set status = 'waiting', next_run_at = $2, node_id = $3, node_entered_at = $4, context = $5 where id = $1`,
            [run.id, out.until.toISOString(), run.node_id, run.node_entered_at.toISOString(), JSON.stringify(run.context)],
          )
          // Log the wait once, when it starts, not on every early re-check.
          if (row.status !== 'waiting' || steps > 1) await logStep(q, run, node.id, `${node.kind}:wait`, out.result ?? {}, actor)
          return { run_id: run.id, advanced: true, steps, status: 'waiting', node_id: node.id }
        }
        if (out.type === 'finish') {
          await q.query(
            `update lp.journey_runs set status = $2, finished_at = $3, next_run_at = null, node_id = $4, context = $5 where id = $1`,
            [run.id, out.status, now.toISOString(), node.id, JSON.stringify(run.context)],
          )
          await logStep(q, run, node.id, `${node.kind}:${out.status}`, out.result ?? {}, actor)
          await emit(q, 'journey_finished', run, row.campaign_id, actor, { status: out.status, node_id: node.id })
          return { run_id: run.id, advanced: true, steps, status: out.status, node_id: node.id }
        }
        // next
        let to: string | null
        if (out.to) to = out.to
        else if (out.path) {
          const p = node.paths.find((x) => x.label === out.path)
          if (!p) throw new Error(`node '${node.id}' chose path '${out.path}', which it does not have`)
          to = p.to
        } else to = node.next
        if (to != null && !findNode(graph, to)) throw new Error(`node '${node.id}' points at unknown node '${to}'`)
        await logStep(q, run, node.id, node.kind, { ...(out.result ?? {}), ...(out.path ? { path: out.path } : {}), to }, actor)
        if (to == null) {
          await q.query(
            `update lp.journey_runs set status = 'done', finished_at = $2, next_run_at = null, context = $3, node_id = $4, node_entered_at = $5 where id = $1`,
            [run.id, now.toISOString(), JSON.stringify(run.context), node.id, run.node_entered_at.toISOString()],
          )
          await emit(q, 'journey_finished', run, row.campaign_id, actor, { status: 'done', node_id: node.id })
          return { run_id: run.id, advanced: true, steps, status: 'done', node_id: node.id }
        }
        run.node_id = to
        run.node_entered_at = now
      }
    }, actor)
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 1000)
    await db.tx(async (q) => {
      const { rows } = await q.query<{ id: number; journey_id: number; version: number; node_id: string }>(
        `update lp.journey_runs set status = 'error', last_error = $2, next_run_at = null, finished_at = $3
          where id = $1 and status in ${OPEN} returning id, journey_id, version, node_id`,
        [runId, message, now.toISOString()],
      )
      if (rows[0]) await logStep(q, rows[0], rows[0].node_id, 'error', { error: message }, actor)
    }, actor)
    return { run_id: runId, advanced: false, steps: 0, status: 'error', error: message }
  }
}

/** Enrol from trigger fires the live journeys have not consumed yet. */
export async function consumeTriggerFires(db: Db, actor = 'system', perJourney = 500): Promise<{ journey_id: number; fires: number; enrolled: number }[]> {
  const { rows: js } = await db.query<{ id: number }>(
    `select id from lp.journeys where status = 'live' and trigger_id is not null and current_version is not null order by id`,
  )
  const out: { journey_id: number; fires: number; enrolled: number }[] = []
  for (const { id } of js) {
    const res = await db.tx(async (q) => {
      // Lock the journey so two ticks never read the same fires twice.
      const { rows } = await q.query<{ trigger_id: number; trigger_cursor: number }>(
        `select trigger_id, trigger_cursor from lp.journeys where id = $1 and status = 'live' for update skip locked`,
        [id],
      )
      if (!rows[0]) return null
      const fires = await q.query<{ id: number; company_id: number | null; contact_id: number | null; payload: Record<string, unknown> }>(
        `select id, company_id, contact_id, payload from lp.trigger_fires
          where trigger_id = $1 and id > $2 order by id limit $3`,
        [rows[0].trigger_id, rows[0].trigger_cursor, perJourney],
      )
      let enrolled = 0
      for (const f of fires.rows) {
        if (f.company_id == null && f.contact_id == null) continue
        try {
          const r = await enrollLead(q, actor, Number(id), {
            company_id: f.company_id == null ? null : Number(f.company_id),
            contact_id: f.contact_id == null ? null : Number(f.contact_id),
            source: 'trigger', trigger_fire_id: Number(f.id), context: { trigger_payload: f.payload ?? {} },
          })
          if (r.enrolled) enrolled++
        } catch (e) {
          // A fire for a lead that was deleted or merged away is skipped, not fatal.
          if (!(e instanceof JourneyError) || e.status !== 404) throw e
        }
      }
      const last = fires.rows.length ? Number(fires.rows[fires.rows.length - 1].id) : null
      if (last != null) await q.query('update lp.journeys set trigger_cursor = $2 where id = $1', [id, last])
      return { journey_id: Number(id), fires: fires.rows.length, enrolled }
    }, actor)
    if (res && res.fires) out.push(res)
  }
  return out
}

/** One runner tick. */
export async function runDueJourneys(
  db: Db, opts: { limit?: number; now?: Date; actor?: string } = {},
): Promise<{ enrolled_from_triggers: number; due: number; advanced: number; errors: number; results: AdvanceResult[] }> {
  const now = opts.now ?? new Date()
  const actor = opts.actor ?? 'system'
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000)
  const consumed = await consumeTriggerFires(db, actor)
  const { rows } = await db.query<{ id: number }>(
    `select r.id from lp.journey_runs r join lp.journeys j on j.id = r.journey_id
      where r.status in ${OPEN} and r.next_run_at <= $1 and j.status in ('live', 'testing', 'sunset')
      order by r.next_run_at, r.id limit $2`,
    [now.toISOString(), limit],
  )
  const results: AdvanceResult[] = []
  for (const r of rows) results.push(await advanceRun(db, Number(r.id), now, actor))
  return {
    enrolled_from_triggers: consumed.reduce((n, c) => n + c.enrolled, 0),
    due: rows.length,
    advanced: results.filter((r) => r.advanced).length,
    errors: results.filter((r) => r.status === 'error').length,
    results: results.filter((r) => r.advanced || r.error),
  }
}
