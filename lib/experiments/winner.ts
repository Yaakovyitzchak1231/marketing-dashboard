/**
 * Auto-winner selection for A/B experiments.
 *
 * This is the variant-winner rule from the insights engine
 * (lib/insights/steps.ts), factored into a reusable pure function: best vs
 * worst variant by reply rate, each with enough sends, with the difference
 * clearing the two-proportion z-test at 95% confidence. The insights copy
 * keeps its own inline version; this module reuses the same statistical
 * core (twoProportionZ, significant) and the same MIN_SENDS_PER_VARIANT
 * default, so the two can never disagree on the math.
 */
import { rate, significant, twoProportionZ } from '../insights/stats.ts'
import { MIN_SENDS_PER_VARIANT } from '../insights/thresholds.ts'
import type { Db } from '../db/types.ts'
import { logEvent } from '../ops/events.ts'
import { ExperimentsError, getExperiment, listOutcomes } from './store.ts'
import type { ExperimentOutcome } from './types.ts'

export interface VariantStats {
  variant: string
  sends: number
  replies: number
}

export interface WinnerPick {
  winner: string
  loser: string
  winner_rate: number
  loser_rate: number
  z: number
}

/**
 * Pick a winner from per-variant stats, or null when there is not enough
 * evidence: fewer than two qualifying variants, or the best-vs-worst gap
 * does not clear 95% significance.
 */
export function selectVariantWinner(
  stats: VariantStats[],
  minSendsPerVariant: number = MIN_SENDS_PER_VARIANT,
): WinnerPick | null {
  const ok = stats
    .filter((v) => v.sends >= minSendsPerVariant && rate(v.replies, v.sends) != null)
    .sort((a, b) => a.variant.localeCompare(b.variant))
  if (ok.length < 2) return null
  const ranked = [...ok].sort(
    (a, b) =>
      (rate(b.replies, b.sends) as number) - (rate(a.replies, a.sends) as number) ||
      a.variant.localeCompare(b.variant),
  )
  const win = ranked[0]
  const lose = ranked[ranked.length - 1]
  const z = twoProportionZ(win.replies, win.sends, lose.replies, lose.sends)
  if (z == null || !significant(z) || z <= 0) return null
  return {
    winner: win.variant,
    loser: lose.variant,
    winner_rate: rate(win.replies, win.sends) as number,
    loser_rate: rate(lose.replies, lose.sends) as number,
    z,
  }
}

export interface Evaluation {
  experiment_id: number
  evaluated_at: string
  eligible: boolean
  reason: string
  pick: WinnerPick | null
  /** True when this evaluation flipped the experiment to decided. */
  decided: boolean
}

/**
 * Evaluate a running experiment. When auto_winner is on and the stats pick a
 * winner, the experiment is marked decided and new assignments go to the
 * winner from then on.
 */
export async function evaluateExperiment(db: Db, actor: string, experimentId: number): Promise<Evaluation> {
  const exp = await getExperiment(db, experimentId)
  if (!exp) throw new ExperimentsError(`No experiment ${experimentId}.`, 404)
  const at = new Date().toISOString()
  if (exp.status === 'decided') {
    return {
      experiment_id: experimentId,
      evaluated_at: at,
      eligible: false,
      reason: `Already decided: variant ${exp.winner_variant}.`,
      pick: null,
      decided: false,
    }
  }
  if (exp.status !== 'running') {
    return {
      experiment_id: experimentId,
      evaluated_at: at,
      eligible: false,
      reason: `Experiment is ${exp.status}; only running experiments can be decided.`,
      pick: null,
      decided: false,
    }
  }
  const outcomes: ExperimentOutcome[] = await listOutcomes(db, experimentId)
  const pick = selectVariantWinner(
    outcomes.map((o) => ({ variant: o.variant, sends: o.sends, replies: o.replies })),
    exp.config.min_sends_per_variant,
  )
  if (!pick) {
    return {
      experiment_id: experimentId,
      evaluated_at: at,
      eligible: false,
      reason: 'Not enough evidence yet: need two variants with enough sends and a 95%-significant gap.',
      pick: null,
      decided: false,
    }
  }
  if (!exp.config.auto_winner) {
    return {
      experiment_id: experimentId,
      evaluated_at: at,
      eligible: true,
      reason: `Variant ${pick.winner} wins on the numbers, but auto-winner is off: decide by hand.`,
      pick,
      decided: false,
    }
  }
  await db.tx(async (q) => {
    await q.query(
      `update lp.experiments set status = 'decided', winner_variant = $2, decided_at = now(), decided_by = $3
       where id = $1 and status = 'running'`,
      [experimentId, pick.winner, actor],
    )
    await logEvent(q, {
      actor,
      kind: 'experiment.decided',
      summary: `${actor} auto-decided A/B experiment "${exp.name}": variant ${pick.winner} wins (${(pick.winner_rate * 100).toFixed(1)}% vs ${(pick.loser_rate * 100).toFixed(1)}% replies, z=${pick.z.toFixed(2)})`,
    })
  }, actor)
  return {
    experiment_id: experimentId,
    evaluated_at: at,
    eligible: true,
    reason: `Variant ${pick.winner} declared the winner.`,
    pick,
    decided: true,
  }
}
