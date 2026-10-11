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
/** Run a rules.ts parser and report a malformed value as a ScoringError (a 400 with the
 *  parser's own message), not a plain Error that the settings form and the ops API turn
 *  into a 500 page (review fix, #74). */
function asScoringError<T>(parse: () => T): T {
  try {
    return parse()
  } catch (e) {
    if (e instanceof ScoringError) throw e
    throw new ScoringError(e instanceof Error ? e.message : String(e))
  }
}

/** max_points: undefined = not given (keep what is stored), null = no cap, else a positive whole number. */
function parseMaxPoints(v: number | null | undefined): number | null | undefined {
  if (v === undefined || v === null) return v
  if (!Number.isInteger(v) || v <= 0) throw new ScoringError('max_points must be a positive whole number, or empty for no cap')
  return v
}

/** Create or update a score model. Validates rules/thresholds shape before writing.
 *  On update, a field that is left out (undefined) keeps its stored value: an update
 *  that only sends rules no longer wipes thresholds or the max_points cap. */
export async function upsertScoreModel(db: Db, actor: string, input: UpsertScoreModelInput): Promise<ScoreModelRow> {
  const rules = asScoringError(() => parseRules(input.rules))
  const thresholdsGiven = input.thresholds !== undefined
  const thresholds = asScoringError(() => parseThresholds(input.thresholds ?? []))
  const maxPoints = parseMaxPoints(input.max_points)
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
        [
          name,
          JSON.stringify(rules),
          JSON.stringify(thresholdsGiven ? thresholds : existing.thresholds),
          maxPoints === undefined ? existing.max_points : maxPoints,
          input.active ?? existing.active,
          input.id,
        ],
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
        [name, input.entity, input.kind, campaignId, JSON.stringify(rules), JSON.stringify(thresholds), maxPoints ?? null, input.active ?? true, actor],
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

/** How many leads one transaction recomputes. Each batch commits on its own, so a
 *  50k-lead recompute is ~200 short transactions of a handful of set-based queries
 *  each, never one giant transaction that a request timeout rolls back (review fix, #74). */
export const SCORE_BATCH_SIZE = 250

function colFor(model: ScoreModelRow): 'company_id' | 'contact_id' {
  return model.entity === 'company' ? 'company_id' : 'contact_id'
}

/** Ids of every lead the model must (re)score: leads with an event its current rules
 *  could match, PLUS leads that already have a score under it -- so a lead whose only
 *  points came from a rule that was since removed is recomputed (and drops) too. */
async function leadIdsToScore(q: Queryable, model: ScoreModelRow): Promise<number[]> {
  const col = colFor(model)
  const eventTypes = [...new Set(model.rules.map((r) => r.event_type))]
  const params: unknown[] = [model.id, eventTypes]
  let campaignClause = ''
  if (model.campaign_id != null) {
    params.push(model.campaign_id)
    campaignClause = ` and campaign_id = $${params.length}`
  }
  const { rows } = await q.query<{ id: number }>(
    `select ${col} as id from lp.lead_events where type = any($2::text[]) and ${col} is not null${campaignClause}
     union
     select ${col} as id from lp.scores where model_id = $1 and ${col} is not null
     order by 1`,
    params,
  )
  return rows.map((r) => Number(r.id))
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

/**
 * Recompute a batch of leads under one model, set-based (a fixed handful of queries
 * per batch, not per lead): rebuild the event-sourced points from the model's CURRENT
 * rules (so an edited or removed rule stops counting -- review fix, #74), sum live
 * points, upsert scores, snapshot history, emit a threshold event on a new crossing.
 * Manual points (no source event) are kept as they are.
 */
async function recomputeBatch(q: Queryable, model: ScoreModelRow, ids: number[], actor: string, now: Date): Promise<RecomputeOneResult[]> {
  if (!ids.length) return []
  const col = colFor(model)
  const keyOf = (id: number) => (model.entity === 'company' ? { company_id: id, contact_id: null } : { company_id: null, contact_id: id })

  // 1. Events for the whole batch in one read.
  const eventTypes = [...new Set(model.rules.map((r) => r.event_type))]
  const byLead = new Map<number, ScorableEvent[]>()
  if (eventTypes.length) {
    const params: unknown[] = [eventTypes, ids]
    let campaignClause = ''
    if (model.campaign_id != null) {
      params.push(model.campaign_id)
      campaignClause = ` and campaign_id = $${params.length}`
    }
    const { rows } = await q.query<{ lead_id: number; id: number; type: string; occurred_at: string; props: Record<string, unknown> }>(
      `select ${col} as lead_id, id, type, occurred_at, props from lp.lead_events
        where type = any($1::text[]) and ${col} = any($2::bigint[])${campaignClause} order by occurred_at`,
      params,
    )
    for (const r of rows) {
      const k = Number(r.lead_id)
      if (!byLead.has(k)) byLead.set(k, [])
      byLead.get(k)!.push(r)
    }
  }

  // 2. Rebuild event-sourced points from the current rules.
  await q.query(`delete from lp.score_points where model_id = $1 and ${col} = any($2::bigint[]) and source_event_id is not null`, [model.id, ids])
  const ins = { company: [] as (number | null)[], contact: [] as (number | null)[], rule: [] as string[], pts: [] as number[], ev: [] as number[], at: [] as string[], exp: [] as (string | null)[] }
  for (const id of ids) {
    for (const a of evaluateEvents(model.rules, byLead.get(id) ?? [])) {
      const k = keyOf(id)
      ins.company.push(k.company_id)
      ins.contact.push(k.contact_id)
      ins.rule.push(a.rule_key)
      ins.pts.push(a.points)
      ins.ev.push(Number(a.source_event_id))
      ins.at.push(new Date(a.awarded_at).toISOString())
      ins.exp.push(a.expires_at ? new Date(a.expires_at).toISOString() : null)
    }
  }
  if (ins.rule.length) {
    await q.query(
      `insert into lp.score_points (model_id, company_id, contact_id, rule_key, points, source_event_id, awarded_at, expires_at)
       select $1, u.co, u.ct, u.rk, u.pt, u.ev, u.at, u.ex
         from unnest($2::bigint[], $3::bigint[], $4::text[], $5::int[], $6::bigint[], $7::timestamptz[], $8::timestamptz[]) as u(co, ct, rk, pt, ev, at, ex)
       on conflict (model_id, rule_key, source_event_id) where source_event_id is not null do nothing`,
      [model.id, ins.company, ins.contact, ins.rule, ins.pts, ins.ev, ins.at, ins.exp],
    )
  }

  // 3. Live points and previous scores, one read each.
  const { rows: pointRows } = await q.query<{ lead_id: number; points: number; expires_at: string | null }>(
    `select ${col} as lead_id, points, expires_at from lp.score_points where model_id = $1 and ${col} = any($2::bigint[])`,
    [model.id, ids],
  )
  const pointsBy = new Map<number, { points: number; expires_at: string | null }[]>()
  for (const p of pointRows) {
    const k = Number(p.lead_id)
    if (!pointsBy.has(k)) pointsBy.set(k, [])
    pointsBy.get(k)!.push({ points: Number(p.points), expires_at: p.expires_at })
  }
  const { rows: prevRows } = await q.query<{ lead_id: number; score: number }>(
    `select ${col} as lead_id, score from lp.scores where model_id = $1 and ${col} = any($2::bigint[])`,
    [model.id, ids],
  )
  const prevBy = new Map(prevRows.map((r) => [Number(r.lead_id), Number(r.score)]))

  // 4. Upsert every score and snapshot the changed ones, one statement each.
  const scores = ids.map((id) => sumScore(pointsBy.get(id) ?? [], model.max_points, now))
  const conflictTarget = model.entity === 'company' ? '(model_id, company_id) where company_id is not null and contact_id is null' : '(model_id, contact_id) where contact_id is not null'
  const otherCol = model.entity === 'company' ? 'contact_id' : 'company_id'
  await q.query(
    `insert into lp.scores (model_id, ${col}, ${otherCol}, score, updated_at)
     select $1, u.id, null, u.score, $4 from unnest($2::bigint[], $3::int[]) as u(id, score)
     on conflict ${conflictTarget} do update set score = excluded.score, updated_at = excluded.updated_at`,
    [model.id, ids, scores, now],
  )
  const changed = ids.map((id, i) => ({ id, score: scores[i] })).filter((x) => x.score !== (prevBy.get(x.id) ?? 0))
  if (changed.length) {
    await q.query(
      `insert into lp.score_history (model_id, ${col}, ${otherCol}, score, recorded_at)
       select $1, u.id, null, u.score, $4 from unnest($2::bigint[], $3::int[]) as u(id, score)`,
      [model.id, changed.map((c) => c.id), changed.map((c) => c.score), now],
    )
  }

  // 5. Threshold crossings (rare) one by one, deduped.
  const out: RecomputeOneResult[] = []
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    const score = scores[i]
    const previousScore = prevBy.get(id) ?? 0
    const k = keyOf(id)
    const newThreshold = thresholdFor(score, model.thresholds)
    const prevThreshold = thresholdFor(previousScore, model.thresholds)
    let crossed = false
    if (newThreshold && (!prevThreshold || newThreshold.min > prevThreshold.min)) {
      crossed = true
      await emitLeadEvent(q, {
        type: 'score_threshold_crossed',
        company_id: k.company_id,
        contact_id: k.contact_id,
        source: 'runner',
        actor,
        props: { model_id: model.id, model_kind: model.kind, score, threshold: newThreshold.key, label: newThreshold.label },
        occurred_at: now,
        dedupe_key: `score_threshold:${model.id}:${model.entity === 'company' ? 'c' : 'k'}${id}:${newThreshold.key}`,
      })
    }
    out.push({ model_id: model.id, ...k, score, previous_score: previousScore, threshold: newThreshold?.key ?? null, threshold_crossed: crossed })
  }
  return out
}

export interface RecomputeScoresInput {
  model_id?: number | null
  company_id?: number | null
  contact_id?: number | null
  /** Override "now" for deterministic expiry testing; defaults to the real clock. */
  now?: Date
  /** Leads per committed transaction for a full recompute (default SCORE_BATCH_SIZE). */
  batch_size?: number
}

/** Recompute one model for one lead, one model for every lead it covers, or every active model for every lead.
 *  One lead: a single transaction. Every lead: committed in batches of `batch_size`. */
export async function recomputeScores(db: Db, actor: string, input: RecomputeScoresInput = {}): Promise<RecomputeOneResult[]> {
  const now = input.now ?? new Date()
  const models = input.model_id ? [await getScoreModel(db, input.model_id)].filter((m): m is ScoreModelRow => m != null) : await listScoreModels(db, { active_only: true })
  if (input.model_id && !models.length) throw new ScoringError(`No score model ${input.model_id}.`, 404)

  if (input.company_id != null || input.contact_id != null) {
    return db.tx(async (q) => {
      const out: RecomputeOneResult[] = []
      for (const model of models) {
        // Skip a model whose entity id this lead doesn't carry (review fix, #74: a
        // contact_id against a company model used to write a junk row, then 23505).
        const id = model.entity === 'company' ? input.company_id : input.contact_id
        if (id == null) continue
        out.push(...(await recomputeBatch(q, model, [Number(id)], actor, now)))
      }
      return out
    }, actor)
  }

  const size = Math.max(1, Math.floor(input.batch_size ?? SCORE_BATCH_SIZE))
  const out: RecomputeOneResult[] = []
  for (const model of models) {
    const ids = await leadIdsToScore(db, model)
    for (let i = 0; i < ids.length; i += size) {
      const chunk = ids.slice(i, i + size)
      out.push(...(await db.tx((q) => recomputeBatch(q, model, chunk, actor, now), actor)))
    }
  }
  return out
}

/** Every model's current score for one lead (company), with its live points. For the lead page header / table column. */
const MODEL_COLS_PREFIXED = 'm.id, m.name, m.entity, m.kind, m.campaign_id, m.rules, m.thresholds, m.max_points, m.active, m.created_at, m.updated_at'

export async function leadScores(q: Queryable, companyId: number): Promise<{ model: ScoreModelRow; score: number | null; threshold: string | null }[]> {
  // score is NULL ("Not scored"), never a made-up 0, for a lead this model has never scored (review fix, #74).
  const { rows } = await q.query<ScoreModelRawRow & { score: number | null }>(
    `select ${MODEL_COLS_PREFIXED}, s.score as score
     from lp.score_models m
     left join lp.scores s on s.model_id = m.id and s.company_id = $1
     where m.entity = 'company' and m.active
     order by m.kind, m.campaign_id nulls first`,
    [companyId],
  )
  return rows.map((r) => {
    const model = hydrate(r)
    const score = r.score == null ? null : Number(r.score)
    return { model, score, threshold: score == null ? null : (thresholdFor(score, model.thresholds)?.key ?? null) }
  })
}

/** For the job runner (kind 'score_refresh', seeded in 0030_scoring.sql): recompute every active model for every lead it covers. */
export async function recomputeAllScores(db: Db, actor = 'system'): Promise<RecomputeOneResult[]> {
  return recomputeScores(db, actor, {})
}
