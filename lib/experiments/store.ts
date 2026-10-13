/**
 * CRUD + outcomes for lp.experiments. Humans (dashboard) and agents (ops API)
 * use the same functions; every change writes one activity-log event.
 */
import type { Db, Queryable } from '../db/types.ts'
import { logEvent } from '../ops/events.ts'
import { MIN_SENDS_PER_VARIANT } from '../insights/thresholds.ts'
import { VARIANT_KEY_PATTERN } from './types.ts'
import type {
  Experiment,
  ExperimentConfig,
  ExperimentDetail,
  ExperimentOutcome,
  ExperimentStatus,
  VariantConfig,
} from './types.ts'

export class ExperimentsError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = 'ExperimentsError'
    this.status = status
  }
}

const STATUSES: ExperimentStatus[] = ['draft', 'running', 'paused', 'decided']

function row(r: Record<string, unknown>): Experiment {
  return {
    id: Number(r.id),
    campaign_id: Number(r.campaign_id),
    step_number: Number(r.step_number),
    name: String(r.name),
    status: r.status as ExperimentStatus,
    config: r.config as ExperimentConfig,
    winner_variant: r.winner_variant == null ? null : String(r.winner_variant),
    evaluated_looks: Number(r.evaluated_looks ?? 0),
    decided_at: r.decided_at == null ? null : new Date(String(r.decided_at)),
    decided_by: r.decided_by == null ? null : String(r.decided_by),
    created_by: r.created_by == null ? null : String(r.created_by),
    created_at: new Date(String(r.created_at)),
    updated_at: new Date(String(r.updated_at)),
  }
}

/** Validate a variant list; returns a normalized config. Throws ExperimentsError. */
export function parseExperimentConfig(input: unknown): ExperimentConfig {
  const c = (input ?? {}) as Record<string, unknown>
  const raw = c.variants
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 8) {
    throw new ExperimentsError('An experiment needs 2 to 8 variants: {variants: [{key, weight}, ...]}.')
  }
  const seen = new Set<string>()
  const variants: VariantConfig[] = raw.map((v, i) => {
    const o = (v ?? {}) as Record<string, unknown>
    const key = String(o.key ?? '').trim()
    const weight = Number(o.weight)
    if (!VARIANT_KEY_PATTERN.test(key)) {
      throw new ExperimentsError(`Variant ${i + 1}: key must be 1-32 characters: letters, digits, _ or - (no ':' or spaces).`)
    }
    if (seen.has(key.toLowerCase())) throw new ExperimentsError(`Duplicate variant key "${key}".`)
    seen.add(key.toLowerCase())
    if (!Number.isFinite(weight) || weight <= 0 || weight > 10000) {
      throw new ExperimentsError(`Variant "${key}": weight must be a positive number.`)
    }
    return { key, weight }
  })
  const minSends = c.min_sends_per_variant
  const minSendsParsed =
    minSends === undefined || minSends === null
      ? MIN_SENDS_PER_VARIANT
      : Number.isInteger(Number(minSends)) && Number(minSends) >= 10
        ? Number(minSends)
        : null
  if (minSendsParsed == null) throw new ExperimentsError('min_sends_per_variant must be an integer >= 10.')
  return { variants, auto_winner: c.auto_winner !== false, min_sends_per_variant: minSendsParsed }
}

export interface CreateExperimentInput {
  campaign_id: number
  step_number: number
  name: string
  config?: unknown
}

export async function createExperiment(db: Db, actor: string, input: CreateExperimentInput): Promise<Experiment> {
  const campaignId = Math.floor(Number(input.campaign_id))
  const stepNumber = Math.floor(Number(input.step_number))
  const name = String(input.name ?? '').trim()
  if (!Number.isInteger(campaignId) || campaignId <= 0) throw new ExperimentsError('campaign_id must be a positive integer.')
  if (!Number.isInteger(stepNumber) || stepNumber < 1 || stepNumber > 1000) {
    throw new ExperimentsError('step_number must be 1-1000.')
  }
  if (name.length < 1 || name.length > 120) throw new ExperimentsError('Name must be 1-120 characters.')
  const config = input.config == null ? parseExperimentConfig({ variants: [{ key: 'A', weight: 50 }, { key: 'B', weight: 50 }] }) : parseExperimentConfig(input.config)
  const c = await db.query<Record<string, unknown>>('select 1 from lp.campaigns where id = $1', [campaignId])
  if (!c.rows.length) throw new ExperimentsError(`No campaign ${campaignId}.`, 404)
  try {
    return await db.tx(async (q) => {
      const ins = await q.query<Record<string, unknown>>(
        `insert into lp.experiments (campaign_id, step_number, name, config, created_by)
         values ($1, $2, $3, $4::jsonb, $5) returning *`,
        [campaignId, stepNumber, name, JSON.stringify(config), actor],
      )
      const exp = row(ins.rows[0])
      await logEvent(q, {
        actor,
        kind: 'experiment.created',
        summary: `${actor} created A/B experiment "${name}" on campaign ${campaignId} step ${stepNumber}`,
      })
      return exp
    }, actor)
  } catch (e) {
    if (e instanceof ExperimentsError) throw e
    if (e instanceof Error && /duplicate|unique/i.test(e.message)) {
      throw new ExperimentsError(`Campaign ${campaignId} step ${stepNumber} already has an experiment.`, 409)
    }
    throw e
  }
}

export async function getExperiment(q: Queryable, id: number): Promise<Experiment | null> {
  const r = await q.query<Record<string, unknown>>('select * from lp.experiments where id = $1', [id])
  return r.rows.length ? row(r.rows[0]) : null
}

export async function listExperiments(q: Queryable, campaignId: number): Promise<Experiment[]> {
  const r = await q.query<Record<string, unknown>>(
    'select * from lp.experiments where campaign_id = $1 order by step_number',
    [campaignId],
  )
  return r.rows.map(row)
}

function outcomeRow(experimentId: number, x: Record<string, unknown>): ExperimentOutcome {
  return {
    experiment_id: experimentId,
    variant: String(x.variant),
    sends: Number(x.sends),
    positive_replies: Number(x.positive_replies),
    updated_at: new Date(String(x.updated_at)),
  }
}

export async function getExperimentDetail(q: Queryable, id: number): Promise<ExperimentDetail | null> {
  const exp = await getExperiment(q, id)
  if (!exp) return null
  const [o, a] = await Promise.all([
    q.query<Record<string, unknown>>('select * from lp.experiment_outcomes where experiment_id = $1 order by variant', [id]),
    q.query<Record<string, unknown>>('select count(*)::int as n from lp.experiment_assignments where experiment_id = $1', [id]),
  ])
  return {
    ...exp,
    outcomes: o.rows.map((x) => outcomeRow(id, x)),
    assignments: Number(a.rows[0]?.n ?? 0),
  }
}

export interface UpdateExperimentInput {
  name?: string
  status?: ExperimentStatus
  /** Required with status 'decided' (a hand decision): one of the configured variant keys. */
  winner_variant?: string
  config?: unknown
}

/**
 * The only status moves. 'decided' is final. Moving to 'decided' by hand needs
 * winner_variant; the auto-winner (lib/experiments/winner.ts) is the other way in.
 * There is no way back to 'draft': once leads were assigned, the experiment
 * cannot be rewritten.
 */
export const ALLOWED_TRANSITIONS: Record<ExperimentStatus, ExperimentStatus[]> = {
  draft: ['running'],
  running: ['paused', 'decided'],
  paused: ['running', 'decided'],
  decided: [],
}

export async function updateExperiment(
  db: Db,
  actor: string,
  id: number,
  input: UpdateExperimentInput,
): Promise<Experiment> {
  const cur = await getExperiment(db, id)
  if (!cur) throw new ExperimentsError(`No experiment ${id}.`, 404)
  const patch: string[] = []
  const params: unknown[] = []
  const set = (col: string, value: unknown, cast = '') => {
    params.push(value)
    patch.push(`${col} = $${params.length}${cast}`)
  }
  if (input.name !== undefined) {
    const name = String(input.name).trim()
    if (name.length < 1 || name.length > 120) throw new ExperimentsError('Name must be 1-120 characters.')
    set('name', name)
  }
  if (input.winner_variant !== undefined && input.status !== 'decided') {
    throw new ExperimentsError('winner_variant is only accepted together with status "decided".')
  }
  let decidedByHand = false
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) throw new ExperimentsError(`Unknown status "${input.status}".`)
    if (!ALLOWED_TRANSITIONS[cur.status].includes(input.status)) {
      throw new ExperimentsError(
        `Cannot move an experiment from ${cur.status} to ${input.status}. ` +
          `Allowed from ${cur.status}: ${ALLOWED_TRANSITIONS[cur.status].join(', ') || 'nothing (it is final)'}.`,
        409,
      )
    }
    if (input.status === 'decided') {
      const w = typeof input.winner_variant === 'string' ? input.winner_variant : ''
      if (!cur.config.variants.some((v) => v.key === w)) {
        throw new ExperimentsError(
          `Deciding by hand needs winner_variant, one of: ${cur.config.variants.map((v) => v.key).join(', ')}.`,
        )
      }
      set('winner_variant', w)
      patch.push('decided_at = now()')
      set('decided_by', actor)
      decidedByHand = true
    }
    set('status', input.status)
  }
  if (input.config !== undefined) {
    // Variants and weights are only editable while nobody has been assigned yet.
    if (cur.status !== 'draft') {
      throw new ExperimentsError(
        `The config can only change while the experiment is a draft (it is ${cur.status}): changing it would orphan the assignments and outcomes already recorded.`,
        409,
      )
    }
    const config = parseExperimentConfig({ ...cur.config, ...(input.config as Record<string, unknown>) })
    set('config', JSON.stringify(config), '::jsonb')
  }
  if (!patch.length) return cur
  const fields = patch.map((p) => p.split(' = ')[0]).join(', ')
  return db.tx(async (q) => {
    // Compare-and-set on the status we validated against: a concurrent pause/decide
    // makes this a 409, never a silent overwrite.
    const upd = await q.query<Record<string, unknown>>(
      `update lp.experiments set ${patch.join(', ')} where id = $${params.length + 1} and status = $${params.length + 2} returning *`,
      [...params, id, cur.status],
    )
    if (!upd.rows.length) {
      throw new ExperimentsError('The experiment changed while you were editing it; reload and try again.', 409)
    }
    const exp = row(upd.rows[0])
    await logEvent(q, {
      actor,
      kind: decidedByHand ? 'experiment.decided' : 'experiment.updated',
      summary: decidedByHand
        ? `${actor} decided A/B experiment "${exp.name}" by hand: variant ${exp.winner_variant} wins`
        : `${actor} updated A/B experiment "${exp.name}" (${fields})`,
    })
    return exp
  }, actor)
}

export interface OutcomeDelta {
  sends?: number
  /**
   * Positive replies ONLY. Auto-replies, unsubscribe requests, and negative
   * replies must never be posted here: the auto-winner treats every counted
   * reply as a win, so non-positive replies would corrupt winner selection.
   * Stored as lp.experiment_outcomes.positive_replies and posted over the API
   * as `positive_replies`.
   */
  positive_replies?: number
  /**
   * Optional idempotency key: a repeat post with the same key (same experiment
   * and variant) returns the current counters without re-applying the delta.
   */
  idempotency_key?: string
}

export type RecordedOutcome = ExperimentOutcome & {
  /** True when this post was a retry of an already-applied idempotency key (nothing was added). */
  replayed: boolean
}

/** A delta count: absent -> 0, otherwise a finite non-negative whole number (never NaN, never a fraction). */
function parseCount(v: unknown, label: string): number {
  if (v === undefined || v === null) return 0
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new ExperimentsError(`${label} must be a non-negative whole number.`)
  }
  return n
}

function violates(e: unknown, constraint: string): boolean {
  if (!(e instanceof Error)) return false
  return (e as { constraint?: string }).constraint === constraint || e.message.includes(constraint)
}

/**
 * Add sends/positive-reply counters for one variant (upsert; counters only grow).
 *
 *  - The experiment must exist, the variant must be one of its configured
 *    variants, and the experiment must be running: anything else is refused, so
 *    a typo or a late post can never create a phantom variant.
 *  - Deltas are non-negative whole numbers. A delta may be replies-only
 *    ({positive_replies: 3}): the rule positive_replies <= sends is a database
 *    constraint on the CUMULATIVE counters, and a violation is a 400.
 *  - An idempotency key is claimed with one atomic insert into
 *    lp.experiment_outcome_keys (primary key experiment, variant, key) in the
 *    same transaction as the counter update, so concurrent retries apply the
 *    delta exactly once.
 * Every accepted delta is written to the activity log with the posting actor.
 */
export async function recordOutcome(
  db: Db,
  actor: string,
  experimentId: number,
  variant: string,
  delta: OutcomeDelta,
): Promise<RecordedOutcome> {
  const sends = parseCount(delta.sends, 'sends')
  const positiveReplies = parseCount(delta.positive_replies, 'positive_replies')
  if (sends === 0 && positiveReplies === 0) {
    throw new ExperimentsError('Post sends and/or positive_replies greater than 0.')
  }
  const idemKey = (delta.idempotency_key ?? '').trim()
  if (idemKey.length > 200) throw new ExperimentsError('idempotency_key must be at most 200 characters.')
  return db.tx(async (q) => {
    // Share-lock the experiment row: a concurrent pause/decide waits for this post to finish.
    const er = await q.query<Record<string, unknown>>('select * from lp.experiments where id = $1 for share', [experimentId])
    if (!er.rows.length) throw new ExperimentsError(`No experiment ${experimentId}.`, 404)
    const exp = row(er.rows[0])
    if (!exp.config.variants.some((v) => v.key === variant)) {
      throw new ExperimentsError(
        `Unknown variant "${variant}" for experiment ${experimentId}. Configured variants: ${exp.config.variants.map((v) => v.key).join(', ')}.`,
      )
    }
    const current = async (): Promise<ExperimentOutcome | null> => {
      const cur = await q.query<Record<string, unknown>>(
        'select * from lp.experiment_outcomes where experiment_id = $1 and variant = $2',
        [experimentId, variant],
      )
      return cur.rows.length ? outcomeRow(experimentId, cur.rows[0]) : null
    }
    if (exp.status !== 'running') {
      if (idemKey) {
        // A retry of a post that was applied while the experiment was running is still a replay.
        const seen = await q.query(
          'select 1 from lp.experiment_outcome_keys where experiment_id = $1 and variant = $2 and key = $3',
          [experimentId, variant, idemKey],
        )
        const cur = seen.rows.length ? await current() : null
        if (cur) return { ...cur, replayed: true }
      }
      throw new ExperimentsError(
        `Outcomes are accepted only while the experiment is running (experiment ${experimentId} is ${exp.status}).`,
        409,
      )
    }
    if (idemKey) {
      const claimed = await q.query(
        `insert into lp.experiment_outcome_keys (experiment_id, variant, key)
         values ($1, $2, $3)
         on conflict (experiment_id, variant, key) do nothing
         returning key`,
        [experimentId, variant, idemKey],
      )
      if (!claimed.rows.length) {
        const cur = await current()
        if (!cur) throw new ExperimentsError(`No outcome row for variant "${variant}" on experiment ${experimentId}.`, 404)
        return { ...cur, replayed: true }
      }
    }
    try {
      // Update first, insert only when the variant has no row yet. (An upsert would check
      // the proposed delta row alone against replies <= sends, which wrongly refuses a
      // replies-only delta; here the constraint sees the cumulative counters.)
      const bump = () =>
        q.query<Record<string, unknown>>(
          `update lp.experiment_outcomes
              set sends = sends + $3, positive_replies = positive_replies + $4, updated_at = now()
            where experiment_id = $1 and variant = $2 returning *`,
          [experimentId, variant, sends, positiveReplies],
        )
      let r = await bump()
      if (!r.rows.length) {
        r = await q.query<Record<string, unknown>>(
          `insert into lp.experiment_outcomes (experiment_id, variant, sends, positive_replies)
           values ($1, $2, $3, $4)
           on conflict (experiment_id, variant) do nothing
           returning *`,
          [experimentId, variant, sends, positiveReplies],
        )
        if (!r.rows.length) r = await bump() // lost a first-insert race: the other row exists now
      }
      const outcome = outcomeRow(experimentId, r.rows[0])
      await logEvent(q, {
        actor,
        kind: 'experiment.outcome',
        summary: `${actor} recorded outcome on experiment ${experimentId} variant "${variant}": +${sends} sends, +${positiveReplies} positive replies`,
        entity_type: 'experiment',
        entity_id: String(experimentId),
        data: { variant, sends, positive_replies: positiveReplies, ...(idemKey ? { idempotency_key: idemKey } : {}) },
      })
      return { ...outcome, replayed: false }
    } catch (e) {
      if (violates(e, 'experiment_outcomes_replies_le_sends')) {
        throw new ExperimentsError(
          'positive_replies cannot exceed sends for a variant (the counters are cumulative: this delta would push positive replies above total sends).',
        )
      }
      throw e
    }
  }, actor)
}

export async function listOutcomes(q: Queryable, experimentId: number): Promise<ExperimentOutcome[]> {
  const r = await q.query<Record<string, unknown>>(
    'select * from lp.experiment_outcomes where experiment_id = $1 order by variant',
    [experimentId],
  )
  return r.rows.map((x) => outcomeRow(experimentId, x))
}
