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

function pathLabel(node: GraphNode, preferred: string[]): string {
  for (const label of preferred) {
    if (node.paths.some((p) => p.label === label)) return label
  }
  return node.paths[node.paths.length - 1].label
}

const branchHandler: NodeHandler = {
  kind: 'branch',
  validate(node) {
    const errs: string[] = []
    if (!node.paths.length) errs.push('add at least one path')
    const labels = new Set(node.paths.map((p) => p.label))
    if (labels.size !== node.paths.length) errs.push('path labels must be unique')
    const iff = node.config.if
    if (iff != null && (typeof iff !== 'object' || Array.isArray(iff))) errs.push('if must be {event} or {entity, field, equals}')
    return errs
  },
  async run({ q, run, node }) {
    const iff = node.config.if
    const since = node.config.since === 'node' ? run.node_entered_at : run.entered_at
    if (iff && typeof iff === 'object' && !Array.isArray(iff)) {
      const spec = iff as Record<string, unknown>
      const yes = await branchIf(q, run, spec, since)
      return { type: 'next', path: pathLabel(node, yes ? ['yes', 'true'] : ['no', 'else', 'no-open']), result: { yes } }
    }
    const types = await seenTypes(q, run, [OPENED, CLICKED], since)
    const label = types.has(CLICKED)
      ? pathLabel(node, ['clicked', 'opened', 'else'])
      : types.has(OPENED)
        ? pathLabel(node, ['opened', 'else', 'no-open'])
        : pathLabel(node, ['no-open', 'no open', 'else', 'no'])
    return { type: 'next', path: label, result: { opened: types.has(OPENED), clicked: types.has(CLICKED) } }
  },
}

async function seenTypes(q: Queryable, run: RunState, types: string[], since: Date): Promise<Set<string>> {
  if (run.company_id == null && run.contact_id == null) return new Set()
  const { rows } = await q.query<{ type: string }>(
    `select distinct type from lp.lead_events
      where type = any($1::text[])
        and recorded_at >= $2
        and (
          ($3::bigint is not null and company_id = $3)
          or ($4::bigint is not null and contact_id = $4)
        )`,
    [types, since.toISOString(), run.company_id, run.contact_id],
  )
  return new Set(rows.map((r) => r.type))
}

async function branchIf(q: Queryable, run: RunState, spec: Record<string, unknown>, since: Date): Promise<boolean> {
  const event = typeof spec.event === 'string' ? spec.event.trim() : ''
  if (event) return (await seenTypes(q, run, [event], since)).has(event)
  const entity = spec.entity === 'contact' ? 'contact' : spec.entity === 'company' ? 'company' : ''
  const field = typeof spec.field === 'string' ? spec.field : ''
  const allowed = entity === 'contact' ? CONTACT_FIELDS : entity === 'company' ? COMPANY_FIELDS : []
  if (!entity || !(allowed as readonly string[]).includes(field)) return false
  const id = entity === 'contact' ? run.contact_id : run.company_id
  if (id == null) return false
  const table = entity === 'contact' ? 'lp.contacts' : 'lp.companies'
  const { rows } = await q.query<Record<string, unknown>>(
    `select ${field} from ${table} where id = $1`,
    [id],
  )
  return String(rows[0]?.[field] ?? '') === String(spec.equals ?? '')
}

const BUILT_IN: NodeHandler[] = [waitHandler, exitHandler, noteHandler, branchHandler]
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
