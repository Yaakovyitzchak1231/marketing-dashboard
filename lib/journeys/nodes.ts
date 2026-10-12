/**
 * Plan 3.1: the node registry. Each node kind is one handler: how to check its
 * config, and what to do when a run reaches it.
 *
 * Built in here (the minimum a journey needs to run end to end):
 *  - `wait`  — hold the run for a duration: config {minutes?, hours?, days?}.
 *              3.4 extends it (wait until a date/slot or a condition, drop-if-replied).
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
}

export type NodeOutcome =
  /** Move on: to the node's `next` (default), to a labelled path, or to an explicit node id. */
  | { type: 'next'; path?: string; to?: string; result?: Record<string, unknown>; context?: Record<string, unknown> }
  /** Stay on this node and come back at `until` (the handler runs again then). */
  | { type: 'wait'; until: Date; result?: Record<string, unknown>; context?: Record<string, unknown> }
  /** End the run. */
  | { type: 'finish'; status: 'done' | 'exited' | 'goal'; result?: Record<string, unknown> }

export interface NodeHandler {
  kind: string
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

const EVENT_RE = /^[a-z][a-z0-9_]{0,63}$/

function dropEvents(config: Record<string, unknown>, context: Record<string, unknown>): string[] {
  const raw = Array.isArray(config.drop_if) ? config.drop_if : config.drop_if != null ? [config.drop_if] : []
  if (config.drop_if_replied === true) raw.push('reply_received')
  const fromRun = Array.isArray(context.cancel_on) ? context.cancel_on : []
  return [...new Set([...raw, ...fromRun].map((x) => String(x).trim()).filter((s) => EVENT_RE.test(s)))]
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
    const drops = dropEvents(node.config, {})
    if (node.config.drop_if != null && drops.length === 0 && node.config.drop_if_replied !== true) {
      errs.push('drop_if must be an event type, like reply_received')
    }
    return errs
  },
  async run({ q, run, node, now }) {
    const drops = dropEvents(node.config, run.context)
    if (drops.length && (run.company_id != null || run.contact_id != null)) {
      const hit = await q.query<{ type: string }>(
        `select type from lp.lead_events
          where type = any($1::text[])
            and recorded_at >= $2
            and (
              ($3::bigint is not null and company_id = $3)
              or ($4::bigint is not null and contact_id = $4)
            )
          order by recorded_at
          limit 1`,
        [drops, run.node_entered_at.toISOString(), run.company_id, run.contact_id],
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
