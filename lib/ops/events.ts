import type { Queryable } from '../db/types.ts'

export interface EventInput {
  actor: string | null
  kind: string
  /** Plain English, reads like a coworker's update: "Tab claimed 'Research Gem Co'". */
  summary: string
  entity_type?: string | null
  entity_id?: string | number | null
  task_id?: number | null
  data?: unknown
}

/** Append one row to the activity log (lp.events is append-only). */
export async function logEvent(q: Queryable, e: EventInput): Promise<number> {
  const { rows } = await q.query<{ id: number }>(
    `insert into lp.events (actor, kind, summary, entity_type, entity_id, task_id, data)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      e.actor,
      e.kind,
      e.summary.slice(0, 2000),
      e.entity_type ?? null,
      e.entity_id == null ? null : String(e.entity_id),
      e.task_id ?? null,
      e.data === undefined ? null : JSON.stringify(e.data),
    ],
  )
  return rows[0].id
}
