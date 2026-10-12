/**
 * Plan 3.1: the node registry. Each node kind is one handler: how to check its
 * config, and what to do when a run reaches it.
 *
 * Built in here (the minimum a journey needs to run end to end):
 *  - `wait`  — hold the run. config:
 *                {minutes?, hours?, days?}  a duration from node_entered_at, and/or
 *                {until?}                   an absolute ISO date-time (a slot); `until` wins when set.
 *                {drop_if_replied?: boolean} exit the run if a reply_received lands, and
 *                {drop_if?: string | string[]} other event types that exit it likewise;
 *                context.cancel_on (a list of event types on the run, e.g. from a 3.3
 *                trigger) is honoured the same way. A drop looks at lp.lead_events with
 *                occurred_at >= the run's journey entry time, so a reply before the lead
 *                reached this node still drops them. While a drop is configured the wait
 *                rechecks at most every minute instead of sleeping to the end. A malformed
 *                or unregistered drop type is an error, never silently ignored.
 *  - `exit`  — end the run now with status `exited`: config {reason?}.
 *  - `note`  — do nothing and move on (a label in the graph; handy in tests).
 *
 * Adding a kind (3.5 branch, 3.7 goal/go-to, 3.8 action, 3.9 send): write a
 * handler and call registerNodeHandler (or add it to BUILT_IN). The handler
 * gets the run, the node, and a Queryable inside the run's transaction, and
 * returns an outcome; the runner does all the bookkeeping (moving the run,
 * logging the step, scheduling the next tick, emitting events).
 */
import type { Queryable } from '../db/types.ts'
import { EVENT_TYPE_KEY_RE } from '../events/type-key.ts'
import type { GraphNode, JourneyGraph } from './graph.ts'

export interface RunState {
  id: number
  journey_id: number
  version: number
  company_id: number | null
  contact_id: number | null
  node_id: string
  /** When the run arrived at this node (a wait measures from here). */
  node_entered_at: Date
  entered_at: Date
  context: Record<string, unknown>
}

export interface NodeContext {
  q: Queryable
  run: RunState
  node: GraphNode
  graph: JourneyGraph
  now: Date
  /**
   * Stable for one visit of this run to this node: the same on every retry, new when a loop
   * brings the run back. Hand it to an outside service as its idempotency key.
   */
  idempotencyKey: string
}

export type NodeOutcome =
  /** Move on: to the node's `next` (default), to a labelled path, or to an explicit node id. */
  | { type: 'next'; path?: string; to?: string; result?: Record<string, unknown>; context?: Record<string, unknown> }
  /** Stay on this node and come back at `until` (the handler runs again then). */
  | { type: 'wait'; until: Date; result?: Record<string, unknown>; context?: Record<string, unknown> }
  /** End the run. */
  | { type: 'finish'; status: 'done' | 'exited' | 'goal'; result?: Record<string, unknown> }

/**
 * Side effects. The runner commits each node on its own. A handler runs inside its node's
 * transaction, and if it throws that transaction rolls back (the run stays on the node and
 * is retried), but nodes the run already passed stay committed. So:
 *  - Database writes through `q` roll back with the node that threw. Safe.
 *  - Anything outside the database (an email, an HTTP call, an Instantly push) is NOT
 *    rolled back. If the node throws after making the call, the retry makes it again.
 *    Pass `ctx.idempotencyKey` to the outside service so a repeat is a no-op there, and
 *    call it as the LAST thing the handler does. A service with no idempotency key is
 *    at-least-once: say so in the node's docs.
 */
export interface NodeHandler {
  kind: string
  /**
   * True when the node can send or push something outside the database. The runner
   * will not run it on a journey version the owner has not approved (journey_approve),
   * and it checks suppression before each run of it.
   */
  sends?: boolean
  /** Problems with this node's config/paths, as plain sentences. Empty when fine. */
  validate(node: GraphNode): string[]
  run(ctx: NodeContext): Promise<NodeOutcome>
}

const MAX_WAIT_MINUTES = 366 * 24 * 60

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
}

const DROP_HINT = "an event type like 'reply_received' (lowercase letters, digits, '_' or '.')"

/** Problems with a wait node's drop settings, as plain sentences. Never filters: a bad entry is reported. */
function dropProblems(config: Record<string, unknown>): string[] {
  const errs: string[] = []
  const flag = config.drop_if_replied
  if (flag != null && typeof flag !== 'boolean') errs.push('drop_if_replied must be true or false')
  const raw = config.drop_if
  if (raw == null) return errs
  const list = Array.isArray(raw) ? raw : [raw]
  if (Array.isArray(raw) && raw.length === 0 && flag !== true) errs.push(`drop_if is empty; list ${DROP_HINT}, or remove it`)
  for (const entry of list) {
    if (typeof entry !== 'string' || !EVENT_TYPE_KEY_RE.test(entry.trim())) {
      errs.push(`drop_if has '${String(entry)}', which is not ${DROP_HINT}`)
    }
  }
  return errs
}

/**
 * Every event type that ends this wait: the node's drop_if, `reply_received`
 * when drop_if_replied, and the run's context.cancel_on. Builds a new list (the
 * node config is never touched). Throws on a malformed entry rather than
 * dropping it, since a silently ignored drop means mailing someone who should
 * have been dropped.
 */
function dropEvents(config: Record<string, unknown>, context: Record<string, unknown>): string[] {
  const problems = dropProblems(config)
  if (problems.length) throw new Error(problems[0])
  const fromConfig = Array.isArray(config.drop_if) ? config.drop_if : config.drop_if != null ? [config.drop_if] : []
  const fromRun = Array.isArray(context.cancel_on) ? context.cancel_on : context.cancel_on != null ? [context.cancel_on] : []
  for (const entry of fromRun) {
    if (typeof entry !== 'string' || !EVENT_TYPE_KEY_RE.test(entry.trim())) {
      throw new Error(`context.cancel_on has '${String(entry)}', which is not ${DROP_HINT}`)
    }
  }
  const all = [...fromConfig, ...fromRun].map((x) => String(x).trim())
  if (config.drop_if_replied === true) all.push('reply_received')
  return [...new Set(all)]
}

function waitUntil(config: Record<string, unknown>): Date | null {
  const raw = config.until
  if (typeof raw !== 'string' || !raw.trim()) return null
  const at = new Date(raw)
  return Number.isNaN(at.getTime()) ? null : at
}

export function waitMinutes(config: Record<string, unknown>): number {
  const m = num(config.minutes) ?? 0
  const h = num(config.hours) ?? 0
  const d = num(config.days) ?? 0
  return m + h * 60 + d * 24 * 60
}

const waitHandler: NodeHandler = {
  kind: 'wait',
  validate(node) {
    const errs: string[] = []
    for (const k of ['minutes', 'hours', 'days']) {
      const v = num(node.config[k])
      if (v !== null && (Number.isNaN(v) || v < 0)) errs.push(`${k} must be a number >= 0`)
    }
    if (errs.length) return errs
    const until = waitUntil(node.config)
    const total = waitMinutes(node.config)
    if (!until && total <= 0) errs.push('set minutes, hours or days (more than 0), or until')
    if (total > MAX_WAIT_MINUTES) errs.push('a wait can be at most 366 days')
    if (node.config.until != null && !until) errs.push('until must be a date-time')
    errs.push(...dropProblems(node.config))
    return errs
  },
  async run({ q, run, node, now }) {
    const drops = dropEvents(node.config, run.context)
    if (drops.length) {
      // An unregistered type can never match, so a typo would be a silent no-drop. Fail loudly.
      const known = await q.query<{ key: string }>('select key from lp.event_types where key = any($1::text[])', [drops])
      const missing = drops.filter((d) => !known.rows.some((r) => r.key === d))
      if (missing.length) throw new Error(`unknown event type(s) to drop on: ${missing.join(', ')}`)
    }
    if (drops.length && (run.company_id != null || run.contact_id != null)) {
      // Since the lead entered the journey (not since this node): a reply that came
      // before they reached the wait still drops them. occurred_at, not recorded_at,
      // so a backfilled event is placed when it happened.
      const hit = await q.query<{ type: string }>(
        `select type from lp.lead_events
          where type = any($1::text[])
            and occurred_at >= $2
            and (
              ($3::bigint is not null and company_id = $3)
              or ($4::bigint is not null and contact_id = $4)
            )
          order by occurred_at
          limit 1`,
        [drops, run.entered_at.toISOString(), run.company_id, run.contact_id],
      )
      if (hit.rows[0]) {
        return { type: 'finish', status: 'exited', result: { dropped: hit.rows[0].type } }
      }
    }
    const end = waitUntil(node.config)
      ?? new Date(run.node_entered_at.getTime() + waitMinutes(node.config) * 60_000)
    if (now.getTime() >= end.getTime()) return { type: 'next', result: { waited_until: end.toISOString() } }
    // A drop condition has to be seen before the wait ends. Recheck within a minute.
    const until = drops.length ? new Date(Math.min(end.getTime(), now.getTime() + 60_000)) : end
    return { type: 'wait', until, result: { until: end.toISOString() } }
  },
}

const exitHandler: NodeHandler = {
  kind: 'exit',
  validate(node) {
    const errs: string[] = []
    if (node.next || node.paths.length) errs.push('an exit node cannot have next or paths')
    const r = node.config.reason
    if (r != null && (typeof r !== 'string' || r.length > 200)) errs.push('reason must be text up to 200 characters')
    return errs
  },
  async run({ node }) {
    return { type: 'finish', status: 'exited', result: node.config.reason ? { reason: node.config.reason } : {} }
  },
}

const noteHandler: NodeHandler = {
  kind: 'note',
  validate: () => [],
  async run() {
    return { type: 'next' }
  },
}

const BUILT_IN: NodeHandler[] = [waitHandler, exitHandler, noteHandler]
const REGISTRY = new Map<string, NodeHandler>(BUILT_IN.map((h) => [h.kind, h]))

export function registerNodeHandler(handler: NodeHandler): void {
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(handler.kind)) throw new Error(`bad node kind '${handler.kind}'`)
  REGISTRY.set(handler.kind, handler)
}

export function getNodeHandler(kind: string): NodeHandler | undefined {
  return REGISTRY.get(kind)
}

export function nodeKinds(): string[] {
  return [...REGISTRY.keys()].sort()
}
