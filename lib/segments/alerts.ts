/**
 * Segment alerts (2.12): an optional growth/shrink threshold on a segment
 * (lp.segments.alert_rule, this slice's migration), checked after each
 * 'segment_snapshot' run against the two most recent daily snapshots.
 * Crossing it writes one lp.notifications row (the existing notify() path,
 * lib/ops/core.ts -- the same one @mentions and task handoffs use; no new
 * delivery channel). lp.segments.last_alerted_on makes a crossing fire
 * exactly once: a second snapshot taken the same day (segment_snapshot is
 * safe to re-run) never re-notifies, and a crossing that persists across
 * several days alerts once, not daily.
 */
import type { Db } from '../db/types.ts'
import { notify } from '../ops/core.ts'

interface AlertRule {
  enabled?: boolean
  shrink_pct?: number
  grow_pct?: number
}

function parseRule(raw: unknown): AlertRule | null {
  if (raw == null || typeof raw !== 'object') return null
  const r = raw as AlertRule
  if (r.enabled === false) return null
  if (r.shrink_pct == null && r.grow_pct == null) return null
  return r
}

function sizeOf(entity: 'company' | 'contact', row: { companies: number; contacts: number }): number {
  return entity === 'company' ? row.companies : row.contacts
}

/** Call after segment_snapshot writes today's rows. Looks only at segments with an
 *  alert_rule configured, so this costs nothing for the common case (no rule set). */
export async function checkSegmentAlerts(db: Db, actor = 'system'): Promise<{ checked: number; alerted: number }> {
  const { rows: segs } = await db.query<{ id: number; name: string; entity: 'company' | 'contact'; alert_rule: AlertRule | null; last_alerted_on: string | null }>(
    `select id, name, entity, alert_rule, last_alerted_on::text as last_alerted_on
       from lp.segments
      where alert_rule is not null and archived_at is null`,
  )
  let alerted = 0
  for (const seg of segs) {
    const rule = parseRule(seg.alert_rule)
    if (!rule) continue
    const { rows: snaps } = await db.query<{ taken_on: string; companies: number; contacts: number }>(
      `select taken_on::text as taken_on, companies, contacts from lp.segment_snapshots
        where segment_id = $1 order by taken_on desc limit 2`,
      [seg.id],
    )
    if (snaps.length < 2) continue
    const [latest, prior] = snaps
    if (seg.last_alerted_on === latest.taken_on) continue // already alerted for this day's snapshot
    const before = sizeOf(seg.entity, prior)
    const after = sizeOf(seg.entity, latest)
    if (before === 0) continue // percent change from zero is undefined, not a real signal
    const pctChange = ((after - before) / before) * 100
    const shrunk = rule.shrink_pct != null && pctChange <= -Math.abs(rule.shrink_pct)
    const grew = rule.grow_pct != null && pctChange >= Math.abs(rule.grow_pct)
    if (!shrunk && !grew) continue
    const direction = shrunk ? 'shrunk' : 'grown'
    const summary = `Segment "${seg.name}" has ${direction} ${Math.abs(Math.round(pctChange))}% (${before} -> ${after}) since its last snapshot.`
    await notify(db, { recipient: 'owner', kind: 'segment_alert', summary, created_by: actor })
    await db.query(`update lp.segments set last_alerted_on = $2 where id = $1`, [seg.id, latest.taken_on])
    alerted++
  }
  return { checked: segs.length, alerted }
}
