/**
 * Plan 3.1: the node registry. Each node kind is one handler: how to check its
 * config, and what to do when a run reaches it.
 *
 * Built in here (the minimum a journey needs to run end to end):
 *  - `wait`  — hold the run for a duration: config {minutes?, hours?, days?}.
 *              3.4 extends it (wait until a date/slot or a condition, drop-if-replied).
 *  - `exit`  — end the run now with status `exited`: config {reason?}.
 *  - `note`  — do nothing and move on (a label in the graph; handy in tests).
 *  - `goal`  — end the run as `goal` (3.7): config {event?}. With an event, the run waits
 *              (re-checking each minute) until that event happened for the lead since the
 *              run entered, then finishes as `goal`; without one it finishes at once.
 *  - `goto`  — jump to another node (3.7): config {to}, the target node id (trimmed when the
 *              graph is validated). The graph counts it as an edge, so the target is reachable.
 *
 * The journey's own `goal.exit_event` and `settings.entry_cap` (3.7) are not nodes; they live
 * in the runner (applyExitCriteria, enrollLead). See docs/journeys.md.
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
  /** Optional: return the node with its config in canonical form (e.g. trimmed ids). Called before validate. */
  normalize?(node: GraphNode): GraphNode
  run(ctx: NodeContext): Promise<NodeOutcome>
}

const MAX_WAIT_MINUTES = 366 * 24 * 60

function num(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : NaN
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
    const total = waitMinutes(node.config)
    if (total <= 0) errs.push('set minutes, hours or days (more than 0)')
    if (total > MAX_WAIT_MINUTES) errs.push('a wait can be at most 366 days')
    return errs
  },
  async run({ run, node, now }) {
    const until = new Date(run.node_entered_at.getTime() + waitMinutes(node.config) * 60_000)
    if (now.getTime() >= until.getTime()) return { type: 'next', result: { waited_until: until.toISOString() } }
    return { type: 'wait', until, result: { until: until.toISOString() } }
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

const EVENT_RE = /^[a-z][a-z0-9_]{0,63}$/

const goalHandler: NodeHandler = {
  kind: 'goal',
  validate(node) {
    const event = node.config.event
    if (event != null && (typeof event !== 'string' || !EVENT_RE.test(event))) return ['event must be an event type, like meeting_booked']
    return []
  },
  async run({ q, run, node, now }) {
    const event = typeof node.config.event === 'string' ? node.config.event : ''
    if (event) {
      const hit = await seenSince(q, run, [event], run.entered_at)
      if (!hit.has(event)) {
        return { type: 'wait', until: new Date(now.getTime() + 60_000), result: { waiting_for: event } }
      }
    }
    return { type: 'finish', status: 'goal', result: event ? { event } : {} }
  },
}

const gotoHandler: NodeHandler = {
  kind: 'goto',
  validate(node) {
    const to = typeof node.config.to === 'string' ? node.config.to.trim() : ''
    if (!to) return ['goto needs config.to, the node id to jump to']
    return []
  },
  normalize(node) {
    return typeof node.config.to === 'string' ? { ...node, config: { ...node.config, to: node.config.to.trim() } } : node
  },
  async run({ node }) {
    // Trim here too: versions published before normalisation may hold a padded id.
    const to = String(node.config.to).trim()
    return { type: 'next', to, result: { to } }
  },
}

/**
 * Which of `types` happened for this run's lead since `since` (by `occurred_at`).
 * Identity is scoped to the run: a contact run matches events for that contact,
 * a company run matches events for that company.
 */
async function seenSince(q: Queryable, run: RunState, types: string[], since: Date): Promise<Set<string>> {
  if (!types.length || (run.company_id == null && run.contact_id == null)) return new Set()
  const { rows } = await q.query<{ type: string }>(
    `select distinct type from lp.lead_events
      where type = any($1::text[])
        and occurred_at >= $2
        and (
          case when $4::bigint is not null then contact_id = $4 else company_id = $3 end
        )`,
    [types, since.toISOString(), run.company_id, run.contact_id],
  )
  return new Set(rows.map((r) => r.type))
}

export { seenSince }

const BUILT_IN: NodeHandler[] = [waitHandler, exitHandler, noteHandler, goalHandler, gotoHandler]
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
