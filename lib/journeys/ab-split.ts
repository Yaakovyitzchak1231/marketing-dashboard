/**
 * Plan 3.8: the `ab_split` journey node.
 *
 * Routes the lead into an A/B experiment variant (lib/experiments); after the
 * experiment decides a winner, every lead goes to the winner. Registered on
 * the plan 3.1 node registry (./nodes.ts) via registerNodeHandler. Import this
 * module once wherever the registry is assembled (the journey runner does)
 * so the kind exists.
 */
import type { GraphNode } from './graph.ts'
import type { NodeContext, NodeHandler, NodeOutcome } from './nodes.ts'
import { registerNodeHandler } from './nodes.ts'
import { assignVariant } from '../experiments/assign.ts'
import { getExperiment } from '../experiments/store.ts'

function num(v: unknown): number | null {
  const n = Math.floor(Number(v))
  return Number.isInteger(n) && n > 0 ? n : null
}

const abSplitHandler: NodeHandler = {
  kind: 'ab_split',
  validate(node: GraphNode): string[] {
    return num(node.config.experiment_id) == null
      ? ['ab_split node needs {experiment_id} (a positive integer)']
      : []
  },
  async run({ q, run, node }: NodeContext): Promise<NodeOutcome> {
    const experimentId = num(node.config.experiment_id)
    if (!experimentId) throw new Error('ab_split node needs {experiment_id}.')
    if (run.company_id == null) throw new Error('ab_split node needs a company on the run.')
    const exp = await getExperiment(q, experimentId)
    if (!exp) throw new Error(`No experiment ${experimentId}.`)
    const jr = await q.query<{ campaign_id: number | null }>(
      'select campaign_id from lp.journeys where id = $1',
      [run.journey_id],
    )
    const journeyCampaignId = jr.rows[0]?.campaign_id ?? null
    if (exp.campaign_id !== journeyCampaignId) {
      throw new Error(
        `Experiment ${experimentId} belongs to campaign ${exp.campaign_id}, ` +
          `not journey ${run.journey_id}'s campaign (${journeyCampaignId}).`,
      )
    }
    const a = await assignVariant(q, experimentId, run.company_id, run.contact_id)
    return {
      type: 'next',
      result: {
        node_id: node.id,
        experiment_id: experimentId,
        variant: a.variant,
        winner: exp.status === 'decided' ? exp.winner_variant : null,
      },
    }
  },
}

registerNodeHandler(abSplitHandler)
