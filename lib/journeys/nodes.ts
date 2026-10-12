/**
 * Journey node registry — plan 3.6.
 *
 * A journey is a graph of nodes; each node type has an executor. The full
 * journey runner (plan 3.1) will call runJourneyNode for every node a lead
 * reaches. This module is the seam: node types register here, and the
 * runner dispatches through it, so new node types never touch runner code.
 *
 * Built-in node types:
 *   ab_split  {experiment_id}  routes the lead into an A/B variant
 *             (lib/experiments). After the experiment decides a winner,
 *             every lead goes to the winner.
 */
import type { Db } from '../db/types.ts'
import { assignVariant } from '../experiments/assign.ts'
import { getExperiment } from '../experiments/store.ts'

export interface JourneyNode {
  /** Stable id of the node inside its journey definition. */
  id: string
  type: string
  config: Record<string, unknown>
}

export interface NodeContext {
  campaign_id: number
  company_id: number
  contact_id: number | null
}

export type NodeResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string }

export type NodeExecutor = (db: Db, actor: string, node: JourneyNode, ctx: NodeContext) => Promise<NodeResult>

const REGISTRY = new Map<string, NodeExecutor>()

export function registerNodeType(type: string, executor: NodeExecutor): void {
  if (REGISTRY.has(type)) throw new Error(`Journey node type "${type}" is already registered.`)
  REGISTRY.set(type, executor)
}

export function nodeTypes(): string[] {
  return [...REGISTRY.keys()]
}

/** Run one node through the registry. Unknown types are an error, never silent. */
export async function runJourneyNode(
  db: Db,
  actor: string,
  node: JourneyNode,
  ctx: NodeContext,
): Promise<NodeResult> {
  const exec = REGISTRY.get(node.type)
  if (!exec) return { ok: false, error: `Unknown journey node type "${node.type}".` }
  try {
    return await exec(db, actor, node, ctx)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function num(v: unknown): number | null {
  const n = Math.floor(Number(v))
  return Number.isInteger(n) && n > 0 ? n : null
}

/** ab_split: route the lead into the experiment's variant (or its winner). */
async function abSplitNode(db: Db, actor: string, node: JourneyNode, ctx: NodeContext): Promise<NodeResult> {
  const experimentId = num(node.config.experiment_id)
  if (!experimentId) return { ok: false, error: 'ab_split node needs {experiment_id}.' }
  const exp = await getExperiment(db, experimentId)
  if (!exp) return { ok: false, error: `No experiment ${experimentId}.` }
  if (exp.campaign_id !== ctx.campaign_id) {
    return { ok: false, error: `Experiment ${experimentId} belongs to campaign ${exp.campaign_id}, not ${ctx.campaign_id}.` }
  }
  try {
    const a = await assignVariant(db, experimentId, ctx.company_id, ctx.contact_id)
    return {
      ok: true,
      data: {
        node_id: node.id,
        experiment_id: experimentId,
        variant: a.variant,
        winner: exp.status === 'decided' ? exp.winner_variant : null,
      },
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

registerNodeType('ab_split', abSplitNode)
