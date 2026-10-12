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
import { JourneyError, getVersionGraph, versionApproved } from './store.ts'

/** Steps one run may take in a single advance, so a loop of instant nodes cannot spin forever. */
export const MAX_STEPS_PER_ADVANCE = 50
/** A handler that throws is retried this many times in all (1, then 5 minutes apart; the third failure ends it), then the run is 'error'. */
export const MAX_ATTEMPTS = 3
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
  reason?: 'already_in' | 'already_entered' | 'duplicate_fire' | 'do_not_contact' | 'suppressed'
}

/** A delayed trigger (3.3) puts cancel_on on the fire payload. Copy it onto the run so later nodes can read it. */
function enrollContext(payload: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const body = payload ?? {}
  const cancel = Array.isArray(body.cancel_on) ? body.cancel_on.filter((x) => typeof x === 'string') : []
  return cancel.length ? { trigger_payload: body, cancel_on: cancel } : { trigger_payload: body }
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

/**
 * Why this lead must not be contacted, or null. A do-not-contact flag or stage blocks
 * the lead; a live suppression blocks it for the journey's campaign (or everywhere):
 *  - on the contact's own email (lp.is_suppressed also matches a forgotten person's hash, 0035);
 *  - on a whole domain (lp.suppressions.domain) that is the company's website domain or the
 *    domain of any email on the company. A company-level run has no single address, so a
 *    domain suppression covers the company however it is addressed.
 * Checked at enrolment and before every step, so a wait cannot outlive an unsubscribe.
 */
async function leadBlock(
  q: Queryable, lead: { company_id: number | null; contact_id: number | null }, campaignId: number | null,
): Promise<'do_not_contact' | 'suppressed' | null> {
  if (lead.company_id != null) {
    const { rows } = await q.query('select 1 from lp.companies where id = $1 and stage = $2', [lead.company_id, 'do_not_contact'])
    if (rows[0]) return 'do_not_contact'
  }
  if (lead.contact_id != null) {
    const { rows } = await q.query<{ do_not_contact: boolean; status: string; email_norm: string | null }>(
      'select do_not_contact, status, email_norm from lp.contacts where id = $1', [lead.contact_id],
    )
    const c = rows[0]
    if (c && (c.do_not_contact || c.status === 'do-not-contact')) return 'do_not_contact'
    if (c?.email_norm) {
      const s = await q.query<{ s: boolean }>('select lp.is_suppressed($1, $2::bigint) as s', [c.email_norm, campaignId])
      if (s.rows[0]?.s) return 'suppressed'
    }
  }
  if (lead.company_id != null) {
    const { rows } = await q.query(
      `select 1 from lp.suppressions s
        where s.domain is not null and s.lifted_at is null
          and (s.expires_at is null or s.expires_at > now())
          and (s.campaign_id is null or s.campaign_id = $2::bigint)
          and (s.domain = (select website_domain from lp.companies where id = $1)
               or s.domain in (select split_part(ct.email_norm, '@', 2) from lp.contacts ct
                                where ct.company_id = $1 and ct.email_norm is not null))
        limit 1`,
      [lead.company_id, campaignId],
    )
    if (rows[0]) return 'suppressed'
  }
  return null
}

/**
 * Is this lead already in the journey (or, for 'once', ever was)? The grain of a run is its
 * contact when it has one, else its company, and a broader run covers a narrower lead:
 *  - a contact is covered by a run for that contact, or by a company-level run for its company;
 *  - a company (no contact) is covered by any run of that company, whoever it was for.
 * So a company never gets the journey twice by being enrolled both ways. `openOnly` limits the
 * check to runs still active or waiting ('multiple' mode: re-entry after a run ends is allowed).
 */
async function alreadyCovered(
  q: Queryable, journeyId: number, lead: { company_id: number | null; contact_id: number | null }, openOnly: boolean,
): Promise<boolean> {
  const { rows } = await q.query(
    `select 1 from lp.journey_runs
      where journey_id = $1
        and ($4::boolean is false or status in ${OPEN})
        and (($3::bigint is not null and contact_id = $3)
             or ($2::bigint is not null and company_id = $2 and ($3::bigint is null or contact_id is null)))
      limit 1`,
    [journeyId, lead.company_id, lead.contact_id, openOnly],
  )
  return !!rows[0]
}

/**
 * Run `fn` inside a savepoint: if it throws, only its own writes are undone and the
 * surrounding transaction stays usable, so one bad lead cannot sink the rest of a batch.
 */
export async function withSavepoint<T>(q: Queryable, name: string, fn: () => Promise<T>): Promise<T> {
  await q.query(`savepoint ${name}`)
  try {
    const out = await fn()
    await q.query(`release savepoint ${name}`)
    return out
  } catch (e) {
    try {
      await q.query(`rollback to savepoint ${name}`)
      await q.query(`release savepoint ${name}`)
    } catch {
      // The transaction itself is broken; the caller's own error is the one worth reporting.
    }
    throw e
  }
}

/** Postgres data and integrity errors (class 22 and 23) repeat on every retry; anything else may be transient. */
export function isDeterministicDbError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^(22|23)/.test(code)
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
  const block = await leadBlock(q, lead, j.campaign_id)
  if (block) return { enrolled: false, run_id: null, reason: block }

  // 'once': never again, even after the earlier run ended. 'multiple': not while one is open.
  if (await alreadyCovered(q, journeyId, lead, j.entry_mode !== 'once')) {
    return { enrolled: false, run_id: null, reason: j.entry_mode === 'once' ? 'already_entered' : 'already_in' }
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

/** Re-open an errored run. It resumes at the node that failed, with its retry count reset. */
export async function retryRun(db: Db, actor: string, runId: number, now: Date = new Date()): Promise<{ run_id: number; status: string }> {
  return db.tx(async (q) => {
    const { rows } = await q.query<{ id: number; journey_id: number; version: number; node_id: string; company_id: number | null; contact_id: number | null }>(
      `select id, journey_id, version, node_id, company_id, contact_id from lp.journey_runs where id = $1 and status = 'error'`, [runId],
    )
    const r = rows[0]
    if (!r) throw new JourneyError('only an errored run can be retried', 409)
    // The open-lead rule: a lead can have only one open run per journey (same grain rules as enrolment).
    const lead = { company_id: r.company_id == null ? null : Number(r.company_id), contact_id: r.contact_id == null ? null : Number(r.contact_id) }
    if (await alreadyCovered(q, Number(r.journey_id), lead, true)) {
      throw new JourneyError('this lead already has an open run in this journey', 409)
    }
    await q.query(
      `update lp.journey_runs set status = 'active', attempts = 0, next_run_at = $2, finished_at = null where id = $1`,
      [runId, now.toISOString()],
    )
    await logStep(q, r, r.node_id, 'retried_by_hand', {}, actor)
    return { run_id: runId, status: 'active' }
  }, actor)
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

type RunRow = RunState & { visit: number; status: string; campaign_id: number | null; journey_status: string }

export interface AdvanceResult {
  run_id: number
  advanced: boolean
  steps: number
  status?: string
  node_id?: string
  error?: string
}

/** What one committed node step leaves for the loop in advanceRun. */
type StepOutcome =
  | { kind: 'idle' }
  | { kind: 'continue'; steps: number }
  | { kind: 'stop'; result: AdvanceResult }

/**
 * Run ONE node of a run, in its own transaction, and commit. A node that moves the run on
 * commits the move (and resets `attempts`), so a later node's failure rolls back only that
 * later node, never an earlier node whose effects already left the database. Every
 * committed path here writes `attempts = 0`: the count means failures since the last success.
 */
async function advanceOnce(
  db: Db, runId: number, now: Date, actor: string, stepsSoFar: number, graphs: Map<string, JourneyGraph | null>,
): Promise<StepOutcome> {
  return db.tx(async (q): Promise<StepOutcome> => {
    const { rows } = await q.query<RunRow>(
      `select r.id, r.journey_id, r.version, r.company_id, r.contact_id, r.node_id, r.node_entered_at, r.entered_at, r.visit,
              r.context, r.status, j.campaign_id, j.status as journey_status
         from lp.journey_runs r join lp.journeys j on j.id = r.journey_id
        where r.id = $1 and r.status in ${OPEN} and r.next_run_at <= $2
          and j.status in ('live', 'testing', 'sunset')
        for update of r skip locked`,
      [runId, now.toISOString()],
    )
    const row = rows[0]
    if (!row) return { kind: 'idle' }
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

    if (stepsSoFar >= MAX_STEPS_PER_ADVANCE) {
      // Not an error: park it and continue on the next tick (a long chain of instant nodes).
      await q.query(`update lp.journey_runs set status = 'active', attempts = 0, next_run_at = $2 where id = $1`, [run.id, now.toISOString()])
      await logStep(q, run, run.node_id, 'step_limit', { steps: stepsSoFar }, actor)
      return { kind: 'stop', result: { run_id: run.id, advanced: true, steps: stepsSoFar, status: 'active', node_id: run.node_id } }
    }
    const node = findNode(graph, run.node_id)
    if (!node) throw new Error(`node '${run.node_id}' is not in version ${run.version}`)
    const handler = getNodeHandler(node.kind)
    if (!handler) throw new Error(`no handler for node kind '${node.kind}'`)
    // Before every step: an unsubscribe or do-not-contact ends the run, even mid-wait.
    const block = await leadBlock(q, run, row.campaign_id)
    if (block) {
      await q.query(
        `update lp.journey_runs set status = 'exited', attempts = 0, finished_at = $2, next_run_at = null, node_id = $3, context = $4 where id = $1`,
        [run.id, now.toISOString(), node.id, JSON.stringify(run.context)],
      )
      await logStep(q, run, node.id, 'exited_suppressed', { reason: block }, actor)
      await emit(q, 'journey_finished', run, row.campaign_id, actor, { status: 'exited', node_id: node.id, reason: block })
      return { kind: 'stop', result: { run_id: run.id, advanced: true, steps: stepsSoFar, status: 'exited', node_id: node.id } }
    }
    // A send-capable node waits for the owner's approval of this run's version. Nothing is sent meanwhile.
    if (handler.sends && !(await versionApproved(q, run.journey_id, run.version))) {
      await q.query(
        `update lp.journey_runs set status = 'waiting', attempts = 0, next_run_at = $2, node_id = $3, node_entered_at = $4, context = $5 where id = $1`,
        [run.id, new Date(now.getTime() + 60 * 60_000).toISOString(), node.id, run.node_entered_at.toISOString(), JSON.stringify(run.context)],
      )
      await logStep(q, run, node.id, 'awaiting_approval', { version: run.version }, actor)
      return { kind: 'stop', result: { run_id: run.id, advanced: true, steps: stepsSoFar, status: 'waiting', node_id: node.id } }
    }
    const out: NodeOutcome = await handler.run({
      q, run, node, graph, now,
      // Stable for one visit to this node (the visit counter only moves when a node move commits, so a
      // retry reuses it) and new on every later visit, even an instant loop back to this node in the same
      // tick. A handler hands it to an outside service so a retry does not repeat the effect.
      idempotencyKey: `journey-run:${run.id}:${node.id}:${Number(row.visit)}`,
    })
    const steps = stepsSoFar + 1
    if ('context' in out && out.context) run.context = { ...run.context, ...out.context }

    if (out.type === 'wait') {
      if (!(out.until instanceof Date) || Number.isNaN(out.until.getTime())) throw new Error(`node '${node.id}' returned a bad wait time`)
      await q.query(
        `update lp.journey_runs set status = 'waiting', attempts = 0, next_run_at = $2, node_id = $3, node_entered_at = $4, context = $5 where id = $1`,
        [run.id, out.until.toISOString(), run.node_id, run.node_entered_at.toISOString(), JSON.stringify(run.context)],
      )
      // Log the wait once, when it starts, not on every early re-check.
      if (row.status !== 'waiting' || steps > 1) await logStep(q, run, node.id, `${node.kind}:wait`, out.result ?? {}, actor)
      return { kind: 'stop', result: { run_id: run.id, advanced: true, steps, status: 'waiting', node_id: node.id } }
    }
    if (out.type === 'finish') {
      await q.query(
        `update lp.journey_runs set status = $2, attempts = 0, finished_at = $3, next_run_at = null, node_id = $4, context = $5 where id = $1`,
        [run.id, out.status, now.toISOString(), node.id, JSON.stringify(run.context)],
      )
      await logStep(q, run, node.id, `${node.kind}:${out.status}`, out.result ?? {}, actor)
      await emit(q, 'journey_finished', run, row.campaign_id, actor, { status: out.status, node_id: node.id })
      return { kind: 'stop', result: { run_id: run.id, advanced: true, steps, status: out.status, node_id: node.id } }
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
        `update lp.journey_runs set status = 'done', attempts = 0, finished_at = $2, next_run_at = null, context = $3, node_id = $4, node_entered_at = $5 where id = $1`,
        [run.id, now.toISOString(), JSON.stringify(run.context), node.id, run.node_entered_at.toISOString()],
      )
      await emit(q, 'journey_finished', run, row.campaign_id, actor, { status: 'done', node_id: node.id })
      return { kind: 'stop', result: { run_id: run.id, advanced: true, steps, status: 'done', node_id: node.id } }
    }
    // Commit the move. The run is due right now, so if this process dies before the next node
    // starts, the next tick picks it up at `to`.
    await q.query(
      `update lp.journey_runs set status = 'active', attempts = 0, node_id = $2, node_entered_at = $3, next_run_at = $3, visit = visit + 1, context = $4 where id = $1`,
      [run.id, to, now.toISOString(), JSON.stringify(run.context)],
    )
    return { kind: 'continue', steps }
  }, actor)
}

/**
 * Advance one run, if it is due and nobody else holds it, until it waits or ends. Each node
 * is its own transaction (advanceOnce). A handler that throws rolls back only its own node:
 * the run stays on it, the failure is counted, and it is retried after a backoff or marked
 * `error` (other runs carry on).
 */
export async function advanceRun(db: Db, runId: number, now: Date = new Date(), actor = 'system'): Promise<AdvanceResult> {
  const graphs = new Map<string, JourneyGraph | null>()
  let steps = 0
  for (;;) {
    let out: StepOutcome
    try {
      out = await advanceOnce(db, runId, now, actor, steps, graphs)
    } catch (e) {
      return recordFailure(db, runId, now, actor, steps, e)
    }
    if (out.kind === 'stop') return out.result
    if (out.kind === 'idle') return steps > 0 ? { run_id: runId, advanced: true, steps, status: 'active' } : { run_id: runId, advanced: false, steps: 0 }
    steps = out.steps
  }
}

/**
 * The node's transaction rolled back, so the run is still on the node it failed at. Count
 * the failure: retry after a backoff, or give up as 'error' after MAX_ATTEMPTS.
 */
async function recordFailure(db: Db, runId: number, now: Date, actor: string, steps: number, e: unknown): Promise<AdvanceResult> {
  const message = (e instanceof Error ? e.message : String(e)).slice(0, 1000)
  try {
    return await db.tx(async (q) => {
      const { rows } = await q.query<{ id: number; journey_id: number; version: number; node_id: string; status: string; attempts: number }>(
        `update lp.journey_runs
            set attempts = attempts + 1,
                last_error = $2,
                status = case when attempts + 1 >= $3::int then 'error' else status end,
                next_run_at = case when attempts + 1 >= $3::int then null
                                   else $4::timestamptz + make_interval(mins => case attempts when 0 then 1 else 5 end) end,
                finished_at = case when attempts + 1 >= $3::int then $4::timestamptz else null end
          where id = $1 and status in ${OPEN}
          returning id, journey_id, version, node_id, status, attempts`,
        [runId, message, MAX_ATTEMPTS, now.toISOString()],
      )
      const r = rows[0]
      if (!r) return { run_id: runId, advanced: steps > 0, steps, status: 'unchanged', error: message }
      await logStep(q, r, r.node_id, r.status === 'error' ? 'error' : 'retry', { error: message, attempt: Number(r.attempts) }, actor)
      return { run_id: runId, advanced: steps > 0, steps, status: r.status, error: message }
    }, actor)
  } catch (recordErr) {
    // The DB is the problem, so the failure could not be recorded. The run is still
    // open, and the next tick tries it again. Other runs carry on.
    const why = recordErr instanceof Error ? recordErr.message : String(recordErr)
    return { run_id: runId, advanced: steps > 0, steps, status: 'unrecorded', error: `${message} (could not record it: ${why.slice(0, 300)})` }
  }
}

/** Enrol from trigger fires the live journeys have not consumed yet. */
export async function consumeTriggerFires(
  db: Db, actor = 'system', perJourney = 500, opts: { deadline?: number; cut?: { reached: boolean } } = {},
): Promise<{
  journey_id: number; fires: number; enrolled: number; skipped: { fire_id: number; reason: string }[]; error?: string
}[]> {
  const { rows: js } = await db.query<{ id: number }>(
    `select id from lp.journeys where status = 'live' and trigger_id is not null and current_version is not null order by id`,
  )
  const out: { journey_id: number; fires: number; enrolled: number; skipped: { fire_id: number; reason: string }[]; error?: string }[] = []
  for (const { id } of js) {
    if (opts.deadline != null && Date.now() >= opts.deadline) {
      if (opts.cut) opts.cut.reached = true
      break
    }
    try {
      const res = await db.tx(async (q) => {
        // Lock the journey so two ticks never read the same fires twice.
        const { rows } = await q.query<{ trigger_id: number; trigger_cursor: number }>(
          `select trigger_id, trigger_cursor from lp.journeys where id = $1 and status = 'live' for update skip locked`,
          [id],
        )
        if (!rows[0]) return null
        // A disabled trigger enrols nobody, whenever its fire was written: those fires are read (so the
        // cursor moves past them and re-enabling the trigger does not replay them) and reported as skipped.
        const fires = await q.query<{ id: number; company_id: number | null; contact_id: number | null; payload: Record<string, unknown>; enabled: boolean }>(
          `select f.id, f.company_id, f.contact_id, f.payload, t.enabled
             from lp.trigger_fires f join lp.triggers t on t.id = f.trigger_id
            where f.trigger_id = $1 and f.id > $2 order by f.id limit $3`,
          [rows[0].trigger_id, rows[0].trigger_cursor, perJourney],
        )
        let enrolled = 0
        const skipped: { fire_id: number; reason: string }[] = []
        for (const f of fires.rows) {
          if (f.company_id == null && f.contact_id == null) continue
          if (!f.enabled) {
            skipped.push({ fire_id: Number(f.id), reason: 'trigger is disabled' })
            continue
          }
          // One bad fire must not hold the cursor, or every later tick fails on it. A lead that
          // was deleted, merged or no longer matches (JourneyError), or a row Postgres rejects as
          // bad data (class 22/23), is skipped and reported; its writes roll back to a savepoint.
          // Anything else (a lock timeout, a dropped connection) may pass, so it fails this
          // journey's read, the cursor stays, and the next tick retries the same fires.
          try {
            const r = await withSavepoint(q, 'fire_sp', () => enrollLead(q, actor, Number(id), {
              company_id: f.company_id == null ? null : Number(f.company_id),
              contact_id: f.contact_id == null ? null : Number(f.contact_id),
              source: 'trigger', trigger_fire_id: Number(f.id), context: enrollContext(f.payload),
            }))
            if (r.enrolled) enrolled++
          } catch (e) {
            if (e instanceof JourneyError) skipped.push({ fire_id: Number(f.id), reason: e.message })
            else if (isDeterministicDbError(e)) skipped.push({ fire_id: Number(f.id), reason: `rejected by the database: ${(e as Error).message}`.slice(0, 300) })
            else throw e
          }
        }
        const last = fires.rows.length ? Number(fires.rows[fires.rows.length - 1].id) : null
        if (last != null) await q.query('update lp.journeys set trigger_cursor = $2 where id = $1', [id, last])
        return { journey_id: Number(id), fires: fires.rows.length, enrolled, skipped }
      }, actor)
      if (res && res.fires) out.push(res)
    } catch (e) {
      // One journey's failure must not stop the other journeys or the due runs behind this call.
      out.push({ journey_id: Number(id), fires: 0, enrolled: 0, skipped: [], error: (e instanceof Error ? e.message : String(e)).slice(0, 300) })
    }
  }
  return out
}

/** A tick stops taking new runs after this long, so the job finishes inside its 120 s timeout. */
export const TICK_BUDGET_MS = 90_000

/**
 * One runner tick. Due runs are taken oldest first. Each run commits on its own, so a
 * tick that runs out of time just leaves the rest for the next one (`deadline_reached`).
 */
export async function runDueJourneys(
  db: Db, opts: { limit?: number; now?: Date; actor?: string; budgetMs?: number } = {},
): Promise<{
  enrolled_from_triggers: number; skipped_fires: number; trigger_errors: number; due: number; advanced: number; errors: number;
  deadline_reached: boolean; results: AdvanceResult[]; trigger_failures: { journey_id: number; error: string }[]
}> {
  const now = opts.now ?? new Date()
  const actor = opts.actor ?? 'system'
  const limit = Math.min(Math.max(opts.limit ?? 500, 1), 5000)
  const deadline = Date.now() + Math.max(opts.budgetMs ?? TICK_BUDGET_MS, 0)
  const cut = { reached: false }
  const consumed = await consumeTriggerFires(db, actor, 500, { deadline, cut })
  const { rows } = await db.query<{ id: number }>(
    `select r.id from lp.journey_runs r join lp.journeys j on j.id = r.journey_id
      where r.status in ${OPEN} and r.next_run_at <= $1 and j.status in ('live', 'testing', 'sunset')
      order by r.next_run_at, r.id limit $2`,
    [now.toISOString(), limit],
  )
  const results: AdvanceResult[] = []
  let deadlineReached = cut.reached
  for (const r of rows) {
    if (Date.now() >= deadline) {
      deadlineReached = true
      break
    }
    // advanceRun reports its own failures; this catches anything it did not expect, so one run cannot stop the rest.
    results.push(await advanceRun(db, Number(r.id), now, actor).catch((e): AdvanceResult => ({
      run_id: Number(r.id), advanced: false, steps: 0, status: 'unrecorded', error: e instanceof Error ? e.message : String(e),
    })))
  }
  return {
    enrolled_from_triggers: consumed.reduce((n, c) => n + c.enrolled, 0),
    skipped_fires: consumed.reduce((n, c) => n + c.skipped.length, 0),
    trigger_errors: consumed.filter((c) => c.error).length,
    trigger_failures: consumed.filter((c) => c.error).map((c) => ({ journey_id: c.journey_id, error: c.error as string })),
    due: rows.length,
    advanced: results.filter((r) => r.advanced).length,
    errors: results.filter((r) => r.status === 'error').length,
    deadline_reached: deadlineReached,
    results: results.filter((r) => r.advanced || r.error),
  }
}
