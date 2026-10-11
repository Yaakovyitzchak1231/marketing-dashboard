/**
 * Segment analytics (plan 2.12): size-over-time from lp.segment_snapshots
 * (written daily by the 'segment_snapshot' runner job, P2-A's op of the same
 * name) plus a small per-segment metrics card. Metrics are read straight from
 * lp.lead_events, which is already on main -- no dependency on another
 * slice's tables. An average score is included ONLY when a score field is
 * actually registered (lead scoring, 2.8, is a sibling PR, not a dependency);
 * the query that reads it also tolerates lp.scores simply not existing yet,
 * same honest-empty-state contract as everywhere else in this phase.
 */
import type { Db, Queryable } from '../db/types.ts'
import type { Segment } from './store.ts'
import { compileSegment, matchingIds } from './compile.ts'
import { allFields } from './fields.ts'

export interface SnapshotPoint {
  taken_on: string
  companies: number
  contacts: number
  sendable: number
}

export interface SegmentMetrics {
  sample_size: number
  sample_capped: boolean
  reply_rate: number | null
  meetings: number | null
  avg_score: number | null
  avg_score_field: string | null
}

export interface SegmentStats {
  segment_id: number
  history: SnapshotPoint[]
  metrics: SegmentMetrics
}

const METRICS_SAMPLE_CAP = 50_000

async function memberIds(db: Db, seg: Segment): Promise<number[]> {
  if (seg.kind === 'static') {
    const col = seg.entity === 'company' ? 'company_id' : 'contact_id'
    const { rows } = await db.query<{ id: number }>(
      `select ${col} as id from lp.segment_members where segment_id = $1 and ${col} is not null limit $2`,
      [seg.id, METRICS_SAMPLE_CAP + 1],
    )
    return rows.map((r) => Number(r.id))
  }
  const compiled = await compileSegment(db, seg.definition)
  const ids = await matchingIds(db, compiled, { limit: METRICS_SAMPLE_CAP + 1 })
  return ids
}

async function replyRateAndMeetings(q: Queryable, entity: 'company' | 'contact', ids: number[]): Promise<{ reply_rate: number | null; meetings: number | null }> {
  if (ids.length === 0) return { reply_rate: null, meetings: null }
  const col = entity === 'company' ? 'company_id' : 'contact_id'
  const { rows } = await q.query<{ replied: string; meetings: string }>(
    `select
       count(distinct case when type = 'reply_received' then ${col} end) as replied,
       count(*) filter (where type = 'meeting_booked') as meetings
     from lp.lead_events
    where ${col} = any($1::bigint[])`,
    [ids],
  )
  const r = rows[0]
  return {
    reply_rate: r ? Number(r.replied) / ids.length : null,
    meetings: r ? Number(r.meetings) : null,
  }
}

/** The first registered score.* field for this entity, if lead scoring (2.8) has
 *  registered one -- undefined (not an error) when it hasn't. */
function scoreFieldFor(entity: 'company' | 'contact'): string | null {
  const match = allFields().find((field) => field.key.startsWith('score.') && field.table === entity)
  return match?.key ?? null
}

async function avgScore(q: Queryable, entity: 'company' | 'contact', ids: number[]): Promise<{ avg_score: number | null; avg_score_field: string | null }> {
  const field = scoreFieldFor(entity)
  if (!field || ids.length === 0) return { avg_score: null, avg_score_field: field }
  const col = entity === 'company' ? 'company_id' : 'contact_id'
  try {
    const { rows } = await q.query<{ avg: string | null }>(`select avg(score)::float as avg from lp.scores where ${col} = any($1::bigint[])`, [ids])
    return { avg_score: rows[0]?.avg == null ? null : Number(rows[0].avg), avg_score_field: field }
  } catch (e) {
    if (/does not exist/i.test((e as Error).message ?? '')) return { avg_score: null, avg_score_field: field }
    throw e
  }
}

export async function segmentStats(db: Db, seg: Segment, days = 90): Promise<SegmentStats> {
  const { rows: history } = await db.query<SnapshotPoint>(
    `select taken_on::text as taken_on, companies, contacts, sendable
       from lp.segment_snapshots
      where segment_id = $1 and taken_on >= current_date - $2::int
      order by taken_on asc`,
    [seg.id, days],
  )
  const ids = await memberIds(db, seg)
  const capped = ids.length > METRICS_SAMPLE_CAP
  const sampleIds = capped ? ids.slice(0, METRICS_SAMPLE_CAP) : ids
  const [rm, sc] = await Promise.all([replyRateAndMeetings(db, seg.entity, sampleIds), avgScore(db, seg.entity, sampleIds)])
  return {
    segment_id: seg.id,
    history,
    metrics: { sample_size: sampleIds.length, sample_capped: capped, reply_rate: rm.reply_rate, meetings: rm.meetings, avg_score: sc.avg_score, avg_score_field: sc.avg_score_field },
  }
}
