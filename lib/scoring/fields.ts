/**
 * What the segment condition engine (plan 2.1, lib/segments — not touched here)
 * can register as fields once it exists: one descriptor per score model, so a
 * segment condition can read "Engagement score >= 20" the same way it reads any
 * other field. Exported, not wired in: the segment engine's own field registry
 * is a different builder's slice; this is the hand-off point.
 */
import type { Queryable } from '@/lib/db/types'
import { listScoreModels } from './engine'

export interface ScoreFieldDescriptor {
  /** A stable key a segment condition would store, e.g. "score.4" (model id 4). */
  key: string
  label: string
  entity: 'company' | 'contact'
  type: 'number'
  model_id: number
}

/** One descriptor per active score model, for the segment engine's field registry to pick up later. */
export async function scoreFieldDescriptors(q: Queryable): Promise<ScoreFieldDescriptor[]> {
  const models = await listScoreModels(q, { active_only: true })
  return models.map((m) => ({
    key: `score.${m.id}`,
    label: m.campaign_id ? `${m.name} (this campaign)` : m.name,
    entity: m.entity,
    type: 'number',
    model_id: m.id,
  }))
}
