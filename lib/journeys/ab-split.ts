/**
 * Plan 3.6: the `ab_split` journey node, a plain plan 3.1 NodeHandler
 * (./nodes.ts): kind 'ab_split', config {experiment_id, variants}.
 *
 * Routing: the lead is assigned a variant (lib/experiments/assign.ts, one
 * assignment per company per experiment) and the run takes the node path whose
 * label is that variant key. Once the experiment has decided a winner, every
 * lead takes the winner's path. The choice is recorded in the run context as
 * `ab_<node id>: {experiment_id, variant}`.
 *
 * Config: `experiment_id` (a positive integer) and `variants`, the variant keys
 * this node routes (2-8 keys, as configured on the experiment). The node needs
 * one path per variant, labelled with the variant key, and no `next`. The graph
 * validator cannot see the database, so it checks the node against the
 * `variants` it declares; at run time the node also checks the experiment's real
 * variants against its paths and fails the run loudly (rather than send a lead
 * down the wrong path) if the experiment gained or renamed a variant.
 *
 * While the experiment is a draft or paused the run waits on this node and
 * retries every AB_WAIT_MINUTES; it does not error. A do-not-contact or
 * suppressed lead leaves the journey (status exited).
 *
 * Import this module once wherever the registry is assembled (the journey
 * runner does) so the kind exists.
 */
import type { GraphNode } from './graph.ts'
import type { NodeContext, NodeHandler, NodeOutcome } from './nodes.ts'
import { registerNodeHandler } from './nodes.ts'
import { assignVariant } from '../experiments/assign.ts'
import { getExperiment } from '../experiments/store.ts'
import { VARIANT_KEY_PATTERN } from '../experiments/types.ts'

/** How long a run waits on the node while its experiment is a draft or paused. */
export const AB_WAIT_MINUTES = 15

function num(v: unknown): number | null {
  const n = Math.floor(Number(v))
  return Number.isInteger(n) && n > 0 ? n : null
}

const abSplitHandler: NodeHandler = {
  kind: 'ab_split',
  validate(node: GraphNode): string[] {
    const errs: string[] = []
    if (num(node.config.experiment_id) == null) errs.push('ab_split node needs {experiment_id} (a positive integer)')
    const raw = node.config.variants
    const keys: string[] = []
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > 8) {
      errs.push("ab_split node needs {variants}: the experiment's 2 to 8 variant keys, e.g. [\"A\", \"B\"]")
    } else {
      for (const k of raw) {
        if (typeof k !== 'string' || !VARIANT_KEY_PATTERN.test(k)) errs.push(`variant ${JSON.stringify(k)} is not a valid variant key (1-32 letters, digits, _ or -)`)
        else if (keys.includes(k)) errs.push(`variant '${k}' is listed twice`)
        else keys.push(k)
      }
    }
    if (node.next) errs.push('an ab_split node routes by its paths, not next: give one path per variant and no next')
    if (keys.length) {
      const labels = node.paths.map((p) => p.label)
      for (const k of keys) if (!labels.includes(k)) errs.push(`no path for variant '${k}': add a path labelled '${k}'`)
      for (const l of labels) if (!keys.includes(l)) errs.push(`path '${l}' is not one of the node's variants (${keys.join(', ')})`)
    }
    return errs
  },
  async run({ q, run, node, now }: NodeContext): Promise<NodeOutcome> {
    const experimentId = num(node.config.experiment_id)
    if (!experimentId) throw new Error('ab_split node needs {experiment_id}.')
    if (run.company_id == null && run.contact_id == null) throw new Error('ab_split node needs a lead (company or contact) on the run.')
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
    const missing = exp.config.variants.map((v) => v.key).filter((k) => !node.paths.some((p) => p.label === k))
    if (missing.length) {
      throw new Error(
        `Node '${node.id}' has no path for experiment ${experimentId} variant(s) ${missing.join(', ')}; ` +
          'publish the journey again with one path per variant.',
      )
    }
    if (exp.status === 'draft' || exp.status === 'paused') {
      return {
        type: 'wait',
        until: new Date(now.getTime() + AB_WAIT_MINUTES * 60_000),
        result: { node_id: node.id, experiment_id: experimentId, waiting_for: `experiment_${exp.status}` },
      }
    }
    const a = await assignVariant(q, experimentId, run.company_id, run.contact_id)
    if (!a.assigned) {
      return { type: 'finish', status: 'exited', result: { node_id: node.id, experiment_id: experimentId, reason: a.reason } }
    }
    const winner = exp.status === 'decided' ? exp.winner_variant : null
    const variant = winner ?? a.variant
    return {
      type: 'next',
      path: variant,
      result: { node_id: node.id, experiment_id: experimentId, variant, assigned_variant: a.variant, winner },
      context: { [`ab_${node.id}`]: { experiment_id: experimentId, variant } },
    }
  },
}

registerNodeHandler(abSplitHandler)
