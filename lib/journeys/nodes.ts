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
  /**
   * Stable for one visit of this run to this node: the same on every retry, new on every later
   * visit, including a loop that comes straight back in the same tick (`lp.journey_runs.visit`
   * counts committed node entries). Hand it to an outside service as its idempotency key.
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

const OPENED = 'email_opened'
const CLICKED = 'email_link_clicked'
const COMPANY_FIELDS = ['stage', 'city', 'state', 'country'] as const
const CONTACT_FIELDS = ['status', 'verification_status'] as const

/** Where a branch measures from: `journey` = the lead's entry (default), `node` = arrival at this branch. */
export const BRANCH_SINCE = ['journey', 'node'] as const
const BRANCH_CONFIG_KEYS = ['if', 'since']
const IF_KEYS = ['event', 'entity', 'field', 'equals']
const EVENT_RE = /^[a-z][a-z0-9_]{0,63}$/

// Path labels each branch mode routes to. Matching ignores case; the first label
// in a list that the node has wins.
const YES_LABELS = ['yes', 'true']
const NO_LABELS = ['no', 'else']
const CLICKED_LABELS = ['clicked']
const OPENED_LABELS = ['opened']
const NO_OPEN_LABELS = ['no-open', 'no open', 'else', 'no']
/** Opened or clicked, but the graph has no path for that: the catch-all. */
const OTHER_LABELS = ['else', 'no-open', 'no open', 'no']

/** The node's own spelling of the first wanted label it has, or null. Never "some other path". */
function findLabel(node: GraphNode, wanted: string[]): string | null {
  for (const w of wanted) {
    const hit = node.paths.find((p) => p.label.toLowerCase() === w)
    if (hit) return hit.label
  }
  return null
}

function pathLabel(node: GraphNode, wanted: string[]): string {
  const label = findLabel(node, wanted)
  if (label == null) throw new Error(`branch '${node.id}' has no path labelled ${wanted.map((w) => `'${w}'`).join(' or ')}`)
  return label
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function branchSince(config: Record<string, unknown>): 'journey' | 'node' {
  return config.since === 'node' ? 'node' : 'journey'
}

function validateIf(spec: Record<string, unknown>): string[] {
  const errs: string[] = []
  for (const k of Object.keys(spec)) if (!IF_KEYS.includes(k)) errs.push(`if has an unknown key '${k}' (use event, or entity + field + equals)`)
  const hasEvent = spec.event !== undefined
  const hasField = spec.entity !== undefined || spec.field !== undefined || 'equals' in spec
  if (hasEvent && hasField) {
    errs.push('if takes either {event} or {entity, field, equals}, not both')
    return errs
  }
  if (hasEvent) {
    if (typeof spec.event !== 'string' || !EVENT_RE.test(spec.event.trim())) errs.push('if.event must be an event type such as reply_received')
    return errs
  }
  if (!hasField) {
    errs.push('if needs {event} or {entity, field, equals}')
    return errs
  }
  const entity = spec.entity
  if (entity !== 'contact' && entity !== 'company') {
    errs.push("if.entity must be 'contact' or 'company'")
    return errs
  }
  const allowed: readonly string[] = entity === 'contact' ? CONTACT_FIELDS : COMPANY_FIELDS
  if (typeof spec.field !== 'string' || !allowed.includes(spec.field)) errs.push(`if.field for a ${entity} must be one of: ${allowed.join(', ')}`)
  if (!('equals' in spec)) errs.push('if.equals is required (use null to match an empty field)')
  else if (spec.equals !== null && !['string', 'number', 'boolean'].includes(typeof spec.equals)) errs.push('if.equals must be text, a number, true/false, or null')
  return errs
}

const branchHandler: NodeHandler = {
  kind: 'branch',
  validate(node) {
    const errs: string[] = []
    if (!node.paths.length) errs.push('add at least one path')
    const labels = new Set(node.paths.map((p) => p.label.toLowerCase()))
    if (labels.size !== node.paths.length) errs.push('path labels must be unique (ignoring case)')
    for (const k of Object.keys(node.config)) if (!BRANCH_CONFIG_KEYS.includes(k)) errs.push(`unknown config key '${k}' (use if, since)`)
    const since = node.config.since
    if (since !== undefined && !(BRANCH_SINCE as readonly unknown[]).includes(since)) errs.push(`since must be one of: ${BRANCH_SINCE.join(', ')} (default journey)`)
    const iff = node.config.if
    if (iff !== undefined) {
      if (!isPlain(iff)) {
        errs.push('if must be {event} or {entity, field, equals}')
        return errs
      }
      errs.push(...validateIf(iff))
      if (!findLabel(node, YES_LABELS)) errs.push("an if branch needs a path labelled 'yes' (or 'true')")
      if (!findLabel(node, NO_LABELS)) errs.push("an if branch needs a path labelled 'no' (or 'else')")
    } else {
      if (!findLabel(node, CLICKED_LABELS) && !findLabel(node, OPENED_LABELS)) errs.push("an open/click branch needs a path labelled 'opened' and/or 'clicked'")
      if (!findLabel(node, NO_OPEN_LABELS)) errs.push("an open/click branch needs a fallback path labelled 'no-open' (or 'else')")
    }
    return errs
  },
  async run({ q, run, node }) {
    const iff = node.config.if
    const sinceAt = branchSince(node.config) === 'node' ? run.node_entered_at : run.entered_at
    if (isPlain(iff)) {
      const yes = await branchIf(q, run, iff, sinceAt)
      return { type: 'next', path: pathLabel(node, yes ? YES_LABELS : NO_LABELS), result: { yes } }
    }
    const types = await seenSince(q, run, [OPENED, CLICKED], sinceAt)
    const clicked = types.has(CLICKED)
    const opened = types.has(OPENED)
    let label: string
    if (clicked) label = findLabel(node, CLICKED_LABELS) ?? findLabel(node, OPENED_LABELS) ?? pathLabel(node, OTHER_LABELS)
    else if (opened) label = findLabel(node, OPENED_LABELS) ?? pathLabel(node, OTHER_LABELS)
    else label = pathLabel(node, NO_OPEN_LABELS)
    return { type: 'next', path: label, result: { opened, clicked } }
  },
}

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
 * Which of `types` happened for this run's lead since `since`. Measured on `occurred_at`
 * (when it happened), not `recorded_at` (when we stored it): a backfill writes an old open
 * with recorded_at = now, and that must not count for a lead who entered later.
 * Identity is scoped to the run, one rule for every node (branch, goal, exit): a contact run
 * matches events for that contact only, a company run matches events for that company.
 * resolveLead fills company_id on contact runs too, so a colleague's event must not count.
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

/**
 * The `if` check. A missing row or a NULL column is "we do not know": it is never
 * equal to '' or to anything else. Only an explicit `equals: null` matches a NULL
 * column (and still not a missing row).
 */
async function branchIf(q: Queryable, run: RunState, spec: Record<string, unknown>, since: Date): Promise<boolean> {
  const event = typeof spec.event === 'string' ? spec.event.trim() : ''
  if (event) return (await seenSince(q, run, [event], since)).has(event)
  const entity = spec.entity === 'contact' ? 'contact' : spec.entity === 'company' ? 'company' : ''
  const field = typeof spec.field === 'string' ? spec.field : ''
  const allowed: readonly string[] = entity === 'contact' ? CONTACT_FIELDS : entity === 'company' ? COMPANY_FIELDS : []
  if (!entity || !allowed.includes(field) || !('equals' in spec)) return false
  const id = entity === 'contact' ? run.contact_id : run.company_id
  if (id == null) return false
  const table = entity === 'contact' ? 'lp.contacts' : 'lp.companies'
  const { rows } = await q.query<Record<string, unknown>>(`select ${field} as v from ${table} where id = $1`, [id])
  if (!rows[0]) return false
  const value = rows[0].v
  if (value == null) return spec.equals === null
  if (spec.equals === null) return false
  return String(value) === String(spec.equals)
}

export { seenSince }

const BUILT_IN: NodeHandler[] = [waitHandler, exitHandler, noteHandler, branchHandler, goalHandler, gotoHandler]
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
