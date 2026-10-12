/**
 * Plan 3.1: the journey graph and its validator.
 *
 * A graph is `{ start, nodes: [{ id, kind, config?, next?, paths? }] }`.
 *  - `next` is the node to go to when this one finishes (null or missing: the run ends, status done).
 *  - `paths` are labelled outgoing edges for nodes that choose (branch, split, check-interaction).
 *    A node handler returns `{ type: 'next', path: '<label>' }` to take one.
 *
 * Which kinds exist is decided by the node registry (lib/journeys/nodes.ts):
 * the validator asks each kind's handler to check its own config, so a new
 * kind (3.4 waits, 3.5 branches, 3.7 goals, 3.8 actions, 3.9 sends) is one
 * handler plus one registry line, with no change here.
 */
import { getNodeHandler, nodeKinds } from './nodes.ts'

export const MAX_NODES = 200
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const LABEL_RE = /^[a-z0-9][a-z0-9_ -]{0,39}$/i

export interface GraphPath {
  label: string
  to: string
}

export interface GraphNode {
  id: string
  kind: string
  config: Record<string, unknown>
  next: string | null
  paths: GraphPath[]
}

export interface JourneyGraph {
  start: string
  nodes: GraphNode[]
}

export class GraphError extends Error {
  errors: string[]
  constructor(errors: string[]) {
    super(`journey graph is not valid: ${errors.join('; ')}`)
    this.errors = errors
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** Every node id a node can move to (next plus its paths). */
export function outgoing(node: GraphNode): string[] {
  const out = node.paths.map((p) => p.to)
  if (node.next) out.push(node.next)
  if (node.kind === 'goto' && typeof node.config.to === 'string' && node.config.to.trim()) out.push(node.config.to.trim())
  return out
}

/**
 * Normalise and check a graph. Throws GraphError listing every problem found.
 * Checks: shape, unique ids, known kinds, each kind's own config, every edge
 * points at a node, and every node is reachable from start. Cycles are allowed
 * (a "go back and wait again" loop is legitimate); the runner caps steps per tick.
 */
export function validateGraph(raw: unknown): JourneyGraph {
  const errors: string[] = []
  if (!isObject(raw)) throw new GraphError(['graph must be an object {start, nodes}'])
  const start = typeof raw.start === 'string' ? raw.start.trim() : ''
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) throw new GraphError(['nodes must be a non-empty array'])
  if (raw.nodes.length > MAX_NODES) throw new GraphError([`at most ${MAX_NODES} nodes`])

  const nodes: GraphNode[] = []
  const ids = new Set<string>()
  raw.nodes.forEach((n, i) => {
    if (!isObject(n)) {
      errors.push(`nodes[${i}] must be an object`)
      return
    }
    const id = typeof n.id === 'string' ? n.id.trim() : ''
    if (!ID_RE.test(id)) errors.push(`nodes[${i}].id must be 1-64 letters, digits, _ or -`)
    else if (ids.has(id)) errors.push(`duplicate node id '${id}'`)
    ids.add(id)
    const kind = typeof n.kind === 'string' ? n.kind.trim() : ''
    if (!getNodeHandler(kind)) errors.push(`node '${id}': unknown kind '${kind}' (known: ${nodeKinds().join(', ')})`)
    if (n.config != null && !isObject(n.config)) errors.push(`node '${id}': config must be an object`)
    const next = n.next == null || n.next === '' ? null : typeof n.next === 'string' ? n.next.trim() : ''
    if (next === '') errors.push(`node '${id}': next must be a node id or null`)
    const paths: GraphPath[] = []
    if (n.paths != null) {
      if (!Array.isArray(n.paths)) errors.push(`node '${id}': paths must be an array`)
      else {
        const labels = new Set<string>()
        n.paths.forEach((p, j) => {
          const label = isObject(p) && typeof p.label === 'string' ? p.label.trim() : ''
          const to = isObject(p) && typeof p.to === 'string' ? p.to.trim() : ''
          if (!LABEL_RE.test(label)) errors.push(`node '${id}': paths[${j}].label must be 1-40 letters, digits, spaces, _ or -`)
          else if (labels.has(label)) errors.push(`node '${id}': duplicate path label '${label}'`)
          labels.add(label)
          if (!to) errors.push(`node '${id}': paths[${j}].to is required`)
          paths.push({ label, to })
        })
      }
    }
    const built: GraphNode = { id, kind, config: isObject(n.config) ? n.config : {}, next, paths }
    nodes.push(getNodeHandler(kind)?.normalize?.(built) ?? built)
  })
  if (errors.length) throw new GraphError(errors)

  if (!ids.has(start)) errors.push(`start '${start}' is not a node id`)
  for (const node of nodes) {
    for (const to of outgoing(node)) if (!ids.has(to)) errors.push(`node '${node.id}' points at unknown node '${to}'`)
    const handler = getNodeHandler(node.kind)
    if (handler) for (const e of handler.validate(node)) errors.push(`node '${node.id}' (${node.kind}): ${e}`)
  }
  if (errors.length) throw new GraphError(errors)

  // Reachability from start.
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const seen = new Set<string>([start])
  const queue = [start]
  while (queue.length) {
    const cur = byId.get(queue.shift() as string)
    if (!cur) continue
    for (const to of outgoing(cur)) if (!seen.has(to)) {
      seen.add(to)
      queue.push(to)
    }
  }
  const unreachable = nodes.filter((n) => !seen.has(n.id)).map((n) => n.id)
  if (unreachable.length) errors.push(`unreachable from start: ${unreachable.join(', ')}`)
  if (errors.length) throw new GraphError(errors)
  return { start, nodes }
}

export function findNode(graph: JourneyGraph, id: string): GraphNode | undefined {
  return graph.nodes.find((n) => n.id === id)
}
