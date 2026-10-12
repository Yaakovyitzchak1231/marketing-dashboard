/**
 * Auto-winner selection for A/B experiments.
 *
 * The statistical core is the insights engine's (lib/insights/stats.ts):
 * reply rates computed from raw counts (positive replies / sends, never an
 * average of rates) and the pooled two-proportion z statistic. On top of that
 * this module adds the controls a repeatedly-evaluated, multi-variant test
 * needs:
 *
 *  1. Minimum sample. EVERY configured variant must have at least
 *     `min_sends_per_variant` sends before any decision (a variant with no
 *     outcome row counts as 0 sends, so it blocks the decision). A variant that
 *     has barely been sent cannot be silently ignored.
 *  2. Best vs every other. The variant with the highest reply rate is compared
 *     with EACH other variant; it wins only if it beats all of them. (Comparing
 *     best vs worst only would crown a winner that a middle variant ties.)
 *  3. Multiple-comparison correction. With k variants there are k-1
 *     comparisons, so each is tested at alpha / (k - 1) (Bonferroni) instead of
 *     alpha, with alpha = 0.05 (two-sided, the same 95% bar as the insights card).
 *  4. Peeking control. Evaluating a running test over and over inflates the
 *     false-positive rate. The control is a fixed look schedule: a "look" is only
 *     taken when the smallest variant's sample reaches min, 2*min, 4*min, ...
 *     (at most MAX_LOOKS looks, tracked in lp.experiments.evaluated_looks), and
 *     each test is corrected for that maximum number of looks as well:
 *     alpha_test = 0.05 / (MAX_LOOKS * (k - 1)). Calling evaluate again before
 *     the next sample milestone does not test anything. After the last look the
 *     auto-winner stops deciding and the owner decides by hand. This is a
 *     conservative Bonferroni guard, not an exact sequential test: it
 *     deliberately gives up power to keep the false-winner rate at or below 5%.
 */
import { CONFIDENCE_Z } from '../insights/thresholds.ts'
import { rate, twoProportionZ } from '../insights/stats.ts'
import { MIN_SENDS_PER_VARIANT } from '../insights/thresholds.ts'
import type { Db } from '../db/types.ts'
import { logEvent } from '../ops/events.ts'
import { ExperimentsError, getExperiment, listOutcomes } from './store.ts'

/** Family-wise false-positive budget for one experiment (two-sided). */
export const ALPHA = 0.05
/** Maximum evaluation looks (sample milestones min, 2min, 4min, 8min, 16min). */
export const MAX_LOOKS = 5

export interface VariantStats {
  variant: string
  sends: number
  /** Positive replies only. */
  positive_replies: number
}

export interface Comparison {
  variant: string
  rate: number
  z: number
}

export interface WinnerPick {
  winner: string
  /** The strongest rival: the other variant the winner beat by the smallest z. */
  loser: string
  winner_rate: number
  loser_rate: number
  /** z of the winner against the strongest rival (the smallest z of all comparisons). */
  z: number
  /** The winner against every other variant. */
  comparisons: Comparison[]
  /** Per-test two-sided alpha after the corrections. */
  alpha: number
  /** The z a comparison had to reach at that alpha. */
  z_critical: number
}

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 erf, |error| < 1.5e-7). */
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * (Math.abs(x) / Math.SQRT2))
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-(x * x) / 2)
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2
}

/** The z a two-sided test must reach at significance `alpha`. 0.05 gives the insights 1.96 exactly. */
export function criticalZ(alpha: number): number {
  if (!(alpha > 0 && alpha < 1)) throw new Error('alpha must be between 0 and 1')
  if (alpha === ALPHA) return CONFIDENCE_Z
  let lo = 0
  let hi = 10
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (2 * (1 - normalCdf(mid)) > alpha) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** Per-test alpha for `variants` variants and up to `looks` looks. */
export function testAlpha(variants: number, looks: number = 1): number {
  return ALPHA / (Math.max(1, variants - 1) * Math.max(1, looks))
}

/**
 * Pick a winner from per-variant stats (ALL the experiment's variants), or null
 * when there is not enough evidence: fewer than two variants, any variant under
 * the minimum sends, or the best variant not beating EVERY other one at the
 * corrected alpha. `looks` is the look budget the alpha is corrected for
 * (evaluateExperiment passes MAX_LOOKS; the default 1 is a single fixed-horizon test).
 */
export function selectVariantWinner(
  stats: VariantStats[],
  minSendsPerVariant: number = MIN_SENDS_PER_VARIANT,
  looks: number = 1,
): WinnerPick | null {
  if (stats.length < 2) return null
  if (stats.some((v) => v.sends < minSendsPerVariant || rate(v.positive_replies, v.sends) == null)) return null
  const ranked = [...stats].sort(
    (a, b) =>
      (rate(b.positive_replies, b.sends) as number) - (rate(a.positive_replies, a.sends) as number) ||
      a.variant.localeCompare(b.variant),
  )
  const win = ranked[0]
  const alpha = testAlpha(stats.length, looks)
  const zCritical = criticalZ(alpha)
  const comparisons: Comparison[] = []
  for (const other of ranked.slice(1)) {
    const z = twoProportionZ(win.positive_replies, win.sends, other.positive_replies, other.sends)
    if (z == null || z < zCritical) return null
    comparisons.push({ variant: other.variant, rate: rate(other.positive_replies, other.sends) as number, z })
  }
  const toughest = comparisons.reduce((m, c) => (c.z < m.z ? c : m))
  return {
    winner: win.variant,
    loser: toughest.variant,
    winner_rate: rate(win.positive_replies, win.sends) as number,
    loser_rate: toughest.rate,
    z: toughest.z,
    comparisons,
    alpha,
    z_critical: zCritical,
  }
}

/**
 * The look number a sample size has reached: 0 below the minimum, 1 at min,
 * 2 at 2*min, 3 at 4*min, ... (the smallest variant's sends decide).
 */
export function lookLevel(smallestSends: number, minSends: number): number {
  if (!(minSends > 0) || smallestSends < minSends) return 0
  let level = 1
  let threshold = minSends * 2
  while (smallestSends >= threshold && level < 64) {
    level++
    threshold *= 2
  }
  return level
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

const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`

/**
 * Evaluate a running experiment (one transaction). When auto_winner is on and a
 * look at a new sample milestone picks a winner, the experiment is marked
 * decided and new assignments go to the winner from then on.
 *
 * The decide step is `update ... where status = 'running' returning id`: if the
 * experiment was paused or decided by someone else in the meantime nothing
 * changes, nothing is logged, and the result says it was not decided.
 */
export async function evaluateExperiment(db: Db, actor: string, experimentId: number): Promise<Evaluation> {
  const at = new Date().toISOString()
  const result = (eligible: boolean, reason: string, pick: WinnerPick | null = null, decided = false): Evaluation => ({
    experiment_id: experimentId, evaluated_at: at, eligible, reason, pick, decided,
  })
  return db.tx(async (q) => {
    const exp = await getExperiment(q, experimentId)
    if (!exp) throw new ExperimentsError(`No experiment ${experimentId}.`, 404)
    if (exp.status === 'decided') return result(false, `Already decided: variant ${exp.winner_variant}.`)
    if (exp.status !== 'running') {
      return result(false, `Experiment is ${exp.status}; only running experiments can be decided.`)
    }
    const min = exp.config.min_sends_per_variant
    const byVariant = new Map((await listOutcomes(q, experimentId)).map((o) => [o.variant, o]))
    // Every configured variant takes part; one with no outcome row has 0 sends.
    const stats: VariantStats[] = exp.config.variants.map((v) => ({
      variant: v.key,
      sends: byVariant.get(v.key)?.sends ?? 0,
      positive_replies: byVariant.get(v.key)?.positive_replies ?? 0,
    }))
    const smallest = Math.min(...stats.map((s) => s.sends))
    const level = lookLevel(smallest, min)
    if (level === 0) {
      return result(false, `Not enough data yet: every variant needs at least ${min} sends (the smallest has ${smallest}).`)
    }
    const look = Math.min(level, MAX_LOOKS)
    if (look <= exp.evaluated_looks) {
      return result(
        false,
        exp.evaluated_looks >= MAX_LOOKS
          ? `All ${MAX_LOOKS} evaluation looks are used without a clear winner; decide by hand.`
          : `Already evaluated at this sample size; the next look is at ${min * 2 ** exp.evaluated_looks} sends per variant (the smallest has ${smallest}).`,
      )
    }
    // Take the look. Guarded, so two concurrent evaluations cannot both use it.
    const took = await q.query(
      `update lp.experiments set evaluated_looks = $2
        where id = $1 and status = 'running' and evaluated_looks < $2 returning id`,
      [experimentId, look],
    )
    if (!took.rows.length) return result(false, 'The experiment changed while it was being evaluated; nothing was decided.')

    const pick = selectVariantWinner(stats, min, MAX_LOOKS)
    if (!pick) {
      return result(
        false,
        `No clear winner at look ${look} of ${MAX_LOOKS}: the best variant has to beat every other variant at the corrected 95% bar (${stats.length} variants, ${MAX_LOOKS} looks).`,
      )
    }
    if (!exp.config.auto_winner) {
      return result(true, `Variant ${pick.winner} wins on the numbers, but auto-winner is off: decide by hand.`, pick)
    }
    const decided = await q.query(
      `update lp.experiments set status = 'decided', winner_variant = $2, decided_at = now(), decided_by = $3
        where id = $1 and status = 'running' returning id`,
      [experimentId, pick.winner, actor],
    )
    if (!decided.rows.length) {
      return result(false, 'The experiment was paused or decided by someone else while it was being evaluated; nothing was decided.', pick)
    }
    await logEvent(q, {
      actor,
      kind: 'experiment.decided',
      summary: `${actor} auto-decided A/B experiment "${exp.name}": variant ${pick.winner} wins (${pct1(pick.winner_rate)} positive replies vs ${pct1(pick.loser_rate)} for the closest rival ${pick.loser}, z=${pick.z.toFixed(2)} at the corrected bar ${pick.z_critical.toFixed(2)})`,
    })
    return result(true, `Variant ${pick.winner} declared the winner.`, pick, true)
  }, actor)
}
