/**
 * Scoring ops for agents (POST /api/ops {op, ...} and the REST aliases in
 * lib/ops/dispatch.ts): list_score_models, upsert_score_model, recompute_scores,
 * lead_scores. One spread line in lib/ops/dispatch.ts, like every other module.
 */
import type { Db } from '@/lib/db/types'
import { OpsError } from '@/lib/ops/core'
import { getScoreModel, leadScores, listScoreModels, recomputeScores, upsertScoreModel, ScoringError, type UpsertScoreModelInput } from './engine'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

function wrap(run: Op['run']): Op['run'] {
  return async (db, actor, a) => {
    try {
      return await run(db, actor, a)
    } catch (e) {
      if (e instanceof ScoringError) throw new OpsError(e.message, e.status)
      throw e
    }
  }
}

function posInt(v: unknown, field: string): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new OpsError(`${field} must be a positive integer`)
  return n
}

export const SCORING_OPS: Record<string, Op> = {
  list_score_models: {
    args: '{campaign_id?, kind?: "engagement"|"fit", active_only?}  -- every score model, or filtered',
    run: wrap((db, _actor, a) =>
      listScoreModels(db, {
        campaign_id: a.campaign_id === undefined ? undefined : a.campaign_id === null ? null : posInt(a.campaign_id, 'campaign_id'),
        kind: typeof a.kind === 'string' ? a.kind : undefined,
        active_only: a.active_only === true || a.active_only === 'true',
      }),
    ),
  },
  get_score_model: {
    args: '{id}',
    run: wrap(async (db, _actor, a) => {
      const m = await getScoreModel(db, posInt(a.id, 'id'))
      if (!m) throw new OpsError(`No score model ${a.id}.`, 404)
      return m
    }),
  },
  upsert_score_model: {
    args: '{id?, name, entity: "company"|"contact", kind: "engagement"|"fit", campaign_id?, rules: [{rule_key,label,event_type,points,expires_after_days?,props_match?}], thresholds?: [{key,label,min}], max_points?, active?}',
    run: wrap((db, actor, a) =>
      upsertScoreModel(db, actor, {
        id: a.id == null ? undefined : posInt(a.id, 'id'),
        name: String(a.name ?? ''),
        entity: a.entity as UpsertScoreModelInput['entity'],
        kind: a.kind as UpsertScoreModelInput['kind'],
        campaign_id: a.campaign_id == null ? null : posInt(a.campaign_id, 'campaign_id'),
        rules: a.rules,
        thresholds: a.thresholds,
        max_points: a.max_points == null ? null : Number(a.max_points),
        active: a.active == null ? undefined : a.active === true || a.active === 'true',
      }),
    ),
  },
  recompute_scores: {
    args: '{model_id?, company_id?, contact_id?, summary?}  -- re-evaluates events, expires stale points, re-sums; omit all args to recompute everyone under every active model (committed in batches of 250). summary: true returns counts instead of one row per lead (what the score_refresh job uses)',
    run: wrap(async (db, actor, a) => {
      const results = await recomputeScores(db, actor, {
        model_id: a.model_id == null ? null : posInt(a.model_id, 'model_id'),
        company_id: a.company_id == null ? null : posInt(a.company_id, 'company_id'),
        contact_id: a.contact_id == null ? null : posInt(a.contact_id, 'contact_id'),
      })
      if (a.summary !== true && a.summary !== 'true') return results
      return {
        leads_scored: results.length,
        models: new Set(results.map((r) => r.model_id)).size,
        changed: results.filter((r) => r.score !== r.previous_score).length,
        threshold_crossings: results.filter((r) => r.threshold_crossed).length,
      }
    }),
  },
  lead_scores: {
    args: '{company_id}  -> every active model\'s current score for this lead',
    run: wrap((db, _actor, a) => leadScores(db, posInt(a.company_id, 'company_id'))),
  },
}
