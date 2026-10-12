/**
 * CRUD + outcomes for lp.experiments. Humans (dashboard) and agents (ops API)
 * use the same functions; every change writes one activity-log event.
 */
import type { Db, Queryable } from '../db/types.ts'
import { logEvent } from '../ops/events.ts'
import { MIN_SENDS_PER_VARIANT } from '../insights/thresholds.ts'
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

const VARIANT_KEY = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,19}$/
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
    if (!VARIANT_KEY.test(key)) {
      throw new ExperimentsError(`Variant ${i + 1}: key must be 1-20 chars (letters, digits, space, _ -).`)
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

export async function getExperimentForStep(
  q: Queryable,
  campaignId: number,
  stepNumber: number,
): Promise<Experiment | null> {
  const r = await q.query<Record<string, unknown>>(
    'select * from lp.experiments where campaign_id = $1 and step_number = $2',
    [campaignId, stepNumber],
  )
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
    replies: Number(x.replies),
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
  config?: unknown
}

/** Status may move draft<->running<->paused; 'decided' is only reached via evaluation. */
const ALLOWED: Record<ExperimentStatus, ExperimentStatus[]> = {
  draft: ['running', 'paused'],
  running: ['paused', 'draft'],
  paused: ['running', 'draft'],
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
  if (input.name !== undefined) {
    const name = String(input.name).trim()
    if (name.length < 1 || name.length > 120) throw new ExperimentsError('Name must be 1-120 characters.')
    patch.push(`name = $${params.length + 1}`)
    params.push(name)
  }
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) throw new ExperimentsError(`Unknown status "${input.status}".`)
    if (input.status === 'decided') throw new ExperimentsError('An experiment is decided only by evaluation, not by hand.')
    if (!ALLOWED[cur.status].includes(input.status)) {
      throw new ExperimentsError(`Cannot move an experiment from ${cur.status} to ${input.status}.`)
    }
    patch.push(`status = $${params.length + 1}`)
    params.push(input.status)
  }
  if (input.config !== undefined) {
    if (cur.status === 'decided') throw new ExperimentsError('A decided experiment is frozen; its config cannot change.')
    const config = parseExperimentConfig({ ...cur.config, ...(input.config as Record<string, unknown>) })
    patch.push(`config = $${params.length + 1}::jsonb`)
    params.push(JSON.stringify(config))
  }
  if (!patch.length) return cur
  const fields = patch.map((p) => p.split(' = ')[0]).join(', ')
  return db.tx(async (q) => {
    const upd = await q.query<Record<string, unknown>>(
      `update lp.experiments set ${patch.join(', ')} where id = $${params.length + 1} returning *`,
      [...params, id],
    )
    const exp = row(upd.rows[0])
    await logEvent(q, {
      actor,
      kind: 'experiment.updated',
      summary: `${actor} updated A/B experiment "${exp.name}" (${fields})`,
    })
    return exp
  }, actor)
}

/** Add sends/replies counters for one variant (upsert; counters only grow). */
export async function recordOutcome(
  db: Db,
  experimentId: number,
  variant: string,
  delta: { sends?: number; replies?: number },
): Promise<ExperimentOutcome> {
  const sends = Math.floor(Number(delta.sends ?? 0))
  const replies = Math.floor(Number(delta.replies ?? 0))
  if (sends < 0 || replies < 0 || replies > sends) {
    throw new ExperimentsError('Outcome deltas need sends >= replies >= 0.')
  }
  try {
    const r = await db.query<Record<string, unknown>>(
      `insert into lp.experiment_outcomes (experiment_id, variant, sends, replies)
       values ($1, $2, $3, $4)
       on conflict (experiment_id, variant) do update
         set sends = lp.experiment_outcomes.sends + excluded.sends,
             replies = lp.experiment_outcomes.replies + excluded.replies,
             updated_at = now()
       returning *`,
      [experimentId, variant, sends, replies],
    )
    return outcomeRow(experimentId, r.rows[0])
  } catch (e) {
    if (e instanceof Error && /foreign key|violates/i.test(e.message)) {
      throw new ExperimentsError(`No experiment ${experimentId}.`, 404)
    }
    throw e
  }
}

export async function listOutcomes(q: Queryable, experimentId: number): Promise<ExperimentOutcome[]> {
  const r = await q.query<Record<string, unknown>>(
    'select * from lp.experiment_outcomes where experiment_id = $1 order by variant',
    [experimentId],
  )
  return r.rows.map((x) => outcomeRow(experimentId, x))
}
