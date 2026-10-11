/**
 * The scoring engine (plan 2.8): applies lp.lead_events to a model's rules,
 * writes lp.score_points, sums the live (non-expired) points into lp.scores,
 * snapshots lp.score_history on change, and emits a 'score_threshold_crossed'
 * lead event the first time a lead's score reaches a new, higher threshold
 * (deduped on the lead_events dedupe_key, so recompute is safe to re-run).
 *
 * Runs inside its own transaction per model (db.tx) so a recompute never
 * leaves scores half-updated.
 */
import type { Db, Queryable } from '@/lib/db/types'
import { emitLeadEvent } from '@/lib/events/emit'
import { evaluateEvents, parseRules, parseThresholds, sumScore, thresholdFor, fitRulesFromProfile, type ScorableEvent, type ScoreRule, type ScoreThreshold } from './rules'

export class ScoringError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message)
    this.name = 'ScoringError'
  }
}

export interface ScoreModelRow {
  id: number
  name: string
  entity: 'company' | 'contact'
  kind: 'engagement' | 'fit'
  campaign_id: number | null
  rules: ScoreRule[]
  thresholds: ScoreThreshold[]
  max_points: number | null
  active: boolean
  created_at: string
  updated_at: string
}

interface ScoreModelRawRow {
  id: number
  name: string
  entity: 'company' | 'contact'
  kind: 'engagement' | 'fit'
  campaign_id: number | null
  rules: unknown
  thresholds: unknown
  max_points: number | null
  active: boolean
  created_at: string
  updated_at: string
}

function hydrate(r: ScoreModelRawRow): ScoreModelRow {
  return { ...r, rules: parseRules(r.rules), thresholds: parseThresholds(r.thresholds) }
}

const MODEL_COLS = 'id, name, entity, kind, campaign_id, rules, thresholds, max_points, active, created_at, updated_at'

export async function listScoreModels(q: Queryable, filter: { campaign_id?: number | null; kind?: string; active_only?: boolean } = {}): Promise<ScoreModelRow[]> {
  const where: string[] = []
  const params: unknown[] = []
  if (filter.kind) {
    params.push(filter.kind)
    where.push(`kind = $${params.length}`)
  }
  if (filter.campaign_id !== undefined) {
    if (filter.campaign_id === null) {
      where.push('campaign_id is null')
    } else {
      params.push(filter.campaign_id)
      where.push(`campaign_id = $${params.length}`)
    }
  }
  if (filter.active_only) where.push('active')
  const sql = `select ${MODEL_COLS} from lp.score_models${where.length ? ' where ' + where.join(' and ') : ''} order by kind, campaign_id nulls first, id`
  const { rows } = await q.query<ScoreModelRawRow>(sql, params)
  return rows.map(hydrate)
}

export async function getScoreModel(q: Queryable, id: number): Promise<ScoreModelRow | null> {
  const { rows } = await q.query<ScoreModelRawRow>(`select ${MODEL_COLS} from lp.score_models where id = $1`, [id])
  return rows[0] ? hydrate(rows[0]) : null
}

export interface UpsertScoreModelInput {
  id?: number
  name: string
  entity: 'company' | 'contact'
  kind: 'engagement' | 'fit'
  campaign_id?: number | null
  rules: unknown
  thresholds?: unknown
  max_points?: number | null
  active?: boolean
}

/** Create or update a score model. Validates rules/thresholds shape before writing. */
export async function upsertScoreModel(db: Db, actor: string, input: UpsertScoreModelInput): Promise<ScoreModelRow> {
  const rules = parseRules(input.rules)
  const thresholds = parseThresholds(input.thresholds ?? [])
  if (input.entity !== 'company' && input.entity !== 'contact') throw new ScoringError('entity must be "company" or "contact"')
  if (input.kind !== 'engagement' && input.kind !== 'fit') throw new ScoringError('kind must be "engagement" or "fit"')
  const name = input.name?.trim()
  if (!name) throw new ScoringError('name is required')

  return db.tx(async (q) => {
    if (input.id) {
      const existing = await getScoreModel(q, input.id)
      if (!existing) throw new ScoringError(`No score model ${input.id}.`, 404)
      const { rows } = await q.query<ScoreModelRawRow>(
        `update lp.score_models set name=$1, rules=$2::jsonb, thresholds=$3::jsonb, max_points=$4, active=$5
         where id=$6 returning ${MODEL_COLS}`,
        [name, JSON.stringify(rules), JSON.stringify(thresholds), input.max_points ?? null, input.active ?? existing.active, input.id],
      )
      await q.query(
        `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by, via, note)
         values ('score_model', $1, 'rules', $2, $3, $4, 'ops_api', $5)`,
        [input.id, JSON.stringify(existing.rules), JSON.stringify(rules), actor, `updated model "${name}"`],
      )
      return hydrate(rows[0])
    }
    const campaignId = input.campaign_id ?? null
    try {
      const { rows } = await q.query<ScoreModelRawRow>(
        `insert into lp.score_models (name, entity, kind, campaign_id, rules, thresholds, max_points, active, created_by)
         values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9) returning ${MODEL_COLS}`,
        [name, input.entity, input.kind, campaignId, JSON.stringify(rules), JSON.stringify(thresholds), input.max_points ?? null, input.active ?? true, actor],
      )
      await q.query(
        `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by, via, note)
         values ('score_model', $1, 'created', null, $2, $3, 'ops_api', $4)`,
        [rows[0].id, name, actor, campaignId ? `new per-campaign ${input.kind} model` : `new default ${input.kind} model`],
      )
      return hydrate(rows[0])
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw new ScoringError(`A ${input.kind} model already exists for ${campaignId ? `campaign ${campaignId}` : 'the workspace default'}.`, 409)
      throw e
    }
  }, actor)
}

/**
 * The Fit model for a campaign: its own per-campaign row if one exists, built
 * fresh from the campaign's profile (ICP + approved signal_rule items) the
 * first time it's needed, or the workspace default Fit model (campaign_id
 * null) when the campaign has no profile items yet. Campaign-agnostic: every
 * rule here is read from the campaign's own rows, nothing hard-coded.
 */
export async function fitModelForCampaign(db: Db, actor: string, campaignId: number): Promise<ScoreModelRow> {
  const existing = await listScoreModels(db, { campaign_id: campaignId, kind: 'fit' })
  if (existing[0]) return existing[0]

  const { rows: items } = await db.query<{ kind: string; name: string; value: string | null; config: Record<string, unknown>; status: string }>(
    `select kind, name, value, config, status from lp.campaign_profile_items where campaign_id = $1 and kind = 'signal_rule' and status = 'approved'`,
    [campaignId],
  )
  const rules = fitRulesFromProfile(items)
  if (!rules.length) {
    // No profile signal rules yet: use the workspace default rather than create an
    // empty per-campaign row that would need recreating once the profile fills in.
    const def = await listScoreModels(db, { campaign_id: null, kind: 'fit' })
    if (def[0]) return def[0]
  }
  return upsertScoreModel(db, actor, {
    name: `Fit — campaign ${campaignId}`,
    entity: 'company',
    kind: 'fit',
    campaign_id: campaignId,
    rules,
    thresholds: [{ key: 'strong_fit', label: 'Strong fit', min: 20 }],
  })
}

interface LeadKey {
  company_id: number | null
  contact_id: number | null
}

/** Distinct leads (company or contact ids) with at least one event the model's rules could match, scoped to the model's campaign if it has one. */
async function leadsToScore(q: Queryable, model: ScoreModelRow): Promise<LeadKey[]> {
  const eventTypes = [...new Set(model.rules.map((r) => r.event_type))]
  if (!eventTypes.length) return []
  const col = model.entity === 'company' ? 'company_id' : 'contact_id'
  const params: unknown[] = [eventTypes]
  let campaignClause = ''
  if (model.campaign_id != null) {
    params.push(model.campaign_id)
    campaignClause = ` and campaign_id = $${params.length}`
  }
  const { rows } = await q.query<{ id: number }>(
    `select distinct ${col} as id from lp.lead_events where type = any($1::text[]) and ${col} is not null${campaignClause}`,
    params,
  )
  return rows.map((r) => (model.entity === 'company' ? { company_id: r.id, contact_id: null } : { company_id: null, contact_id: r.id }))
}

async function eventsForLead(q: Queryable, model: ScoreModelRow, lead: LeadKey): Promise<ScorableEvent[]> {
  const eventTypes = [...new Set(model.rules.map((r) => r.event_type))]
  if (!eventTypes.length) return []
  const col = model.entity === 'company' ? 'company_id' : 'contact_id'
  const id = model.entity === 'company' ? lead.company_id : lead.contact_id
  const params: unknown[] = [eventTypes, id]
  let campaignClause = ''
  if (model.campaign_id != null) {
    params.push(model.campaign_id)
    campaignClause = ` and campaign_id = $${params.length}`
  }
  const { rows } = await q.query<{ id: number; type: string; occurred_at: string; props: Record<string, unknown> }>(
    `select id, type, occurred_at, props from lp.lead_events where type = any($1::text[]) and ${col} = $2${campaignClause} order by occurred_at`,
    params,
  )
  return rows
}

export interface RecomputeOneResult {
  model_id: number
  company_id: number | null
  contact_id: number | null
  score: number
  previous_score: number
  threshold: string | null
  threshold_crossed: boolean
}

/** Recompute one lead's score under one model: award new points, sum live points, snapshot history, emit a threshold event on a new crossing. */
async function recomputeLead(q: Queryable, model: ScoreModelRow, lead: LeadKey, actor: string, now: Date): Promise<RecomputeOneResult> {
  const events = await eventsForLead(q, model, lead)
  const awards = evaluateEvents(model.rules, events)
  for (const a of awards) {
    await q.query(
      `insert into lp.score_points (model_id, company_id, contact_id, rule_key, points, source_event_id, awarded_at, expires_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8)
       on conflict (model_id, rule_key, source_event_id) where source_event_id is not null do nothing`,
      [model.id, lead.company_id, lead.contact_id, a.rule_key, a.points, a.source_event_id, a.awarded_at, a.expires_at],
    )
  }

  const col = model.entity === 'company' ? 'company_id' : 'contact_id'
  const id = model.entity === 'company' ? lead.company_id : lead.contact_id
  const { rows: pointRows } = await q.query<{ points: number; expires_at: string | null }>(
    `select points, expires_at from lp.score_points where model_id = $1 and ${col} = $2`,
    [model.id, id],
  )
  const score = sumScore(pointRows, model.max_points, now)

  const { rows: prevRows } = await q.query<{ score: number }>(`select score from lp.scores where model_id = $1 and ${col} = $2`, [model.id, id])
  const previousScore = prevRows[0]?.score ?? 0

  const conflictTarget = model.entity === 'company' ? '(model_id, company_id) where company_id is not null and contact_id is null' : '(model_id, contact_id) where contact_id is not null'
  await q.query(
    `insert into lp.scores (model_id, company_id, contact_id, score, updated_at) values ($1,$2,$3,$4,$5)
     on conflict ${conflictTarget} do update set score = excluded.score, updated_at = excluded.updated_at`,
    [model.id, lead.company_id, lead.contact_id, score, now],
  )

  if (score !== previousScore) {
    await q.query(`insert into lp.score_history (model_id, company_id, contact_id, score, recorded_at) values ($1,$2,$3,$4,$5)`, [model.id, lead.company_id, lead.contact_id, score, now])
  }

  const newThreshold = thresholdFor(score, model.thresholds)
  const prevThreshold = thresholdFor(previousScore, model.thresholds)
  let crossed = false
  if (newThreshold && (!prevThreshold || newThreshold.min > prevThreshold.min)) {
    crossed = true
    await emitLeadEvent(q, {
      type: 'score_threshold_crossed',
      company_id: lead.company_id,
      contact_id: lead.contact_id,
      source: 'runner',
      actor,
      props: { model_id: model.id, model_kind: model.kind, score, threshold: newThreshold.key, label: newThreshold.label },
      occurred_at: now,
      dedupe_key: `score_threshold:${model.id}:${model.entity === 'company' ? 'c' + lead.company_id : 'k' + lead.contact_id}:${newThreshold.key}`,
    })
  }

  return { model_id: model.id, company_id: lead.company_id, contact_id: lead.contact_id, score, previous_score: previousScore, threshold: newThreshold?.key ?? null, threshold_crossed: crossed }
}

export interface RecomputeScoresInput {
  model_id?: number | null
  company_id?: number | null
  contact_id?: number | null
  /** Override "now" for deterministic expiry testing; defaults to the real clock. */
  now?: Date
}

/** Recompute one model for one lead, one model for every lead it covers, or every active model for every lead. */
export async function recomputeScores(db: Db, actor: string, input: RecomputeScoresInput = {}): Promise<RecomputeOneResult[]> {
  const now = input.now ?? new Date()
  const models = input.model_id ? [await getScoreModel(db, input.model_id)].filter((m): m is ScoreModelRow => m != null) : await listScoreModels(db, { active_only: true })
  if (input.model_id && !models.length) throw new ScoringError(`No score model ${input.model_id}.`, 404)

  return db.tx(async (q) => {
    const out: RecomputeOneResult[] = []
    for (const model of models) {
      const leads: LeadKey[] =
        input.company_id != null || input.contact_id != null
          ? [{ company_id: input.company_id ?? null, contact_id: input.contact_id ?? null }]
          : await leadsToScore(q, model)
      for (const lead of leads) {
        out.push(await recomputeLead(q, model, lead, actor, now))
      }
    }
    return out
  }, actor)
}

/** Every model's current score for one lead (company), with its live points. For the lead page header / table column. */
const MODEL_COLS_PREFIXED = 'm.id, m.name, m.entity, m.kind, m.campaign_id, m.rules, m.thresholds, m.max_points, m.active, m.created_at, m.updated_at'

export async function leadScores(q: Queryable, companyId: number): Promise<{ model: ScoreModelRow; score: number; threshold: string | null }[]> {
  const { rows } = await q.query<ScoreModelRawRow & { score: number }>(
    `select ${MODEL_COLS_PREFIXED}, coalesce(s.score, 0) as score
     from lp.score_models m
     left join lp.scores s on s.model_id = m.id and s.company_id = $1
     where m.entity = 'company' and m.active
     order by m.kind, m.campaign_id nulls first`,
    [companyId],
  )
  return rows.map((r) => {
    const model = hydrate(r)
    return { model, score: r.score, threshold: thresholdFor(r.score, model.thresholds)?.key ?? null }
  })
}

/** For the job runner (kind 'score_refresh', seeded in 0030_scoring.sql): recompute every active model for every lead it covers. */
export async function recomputeAllScores(db: Db, actor = 'system'): Promise<RecomputeOneResult[]> {
  return recomputeScores(db, actor, {})
}
