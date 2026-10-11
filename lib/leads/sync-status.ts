/**
 * One-way status sync, Lead Master (Sheet) -> lp.contacts.status.
 *
 * The normal import never overwrites a status already in the database (after the
 * move the database is the source of truth). This is the deliberate exception, for
 * catching the database up with status changes made in the Sheet: for every row
 * whose email matches a contact and whose Sheet status differs from the database,
 * the Sheet's status is written. Nothing else on the contact changes, contacts are
 * never created or deleted, and rows whose status already matches are not touched.
 *
 * Every change is logged twice: lp.status_history (by the contacts trigger, with
 * the calling agent as changed_by) and one lp.events row per call (kind
 * 'import.status_sync', the agent as actor, each email's old -> new in data).
 * A dry run computes exactly the same changes and writes nothing.
 */
import type { Db, Queryable } from '../db/types.ts'
import { normalizeEmail } from './normalize.ts'
import { sheetStatus } from './import.ts'
import { addSuppressionIn } from '../suppressions/store.ts'

export interface StatusSyncStats {
  rows: number
  skipped_no_email: number
  not_in_database: number
  unknown_status: number
  unchanged: number
  changed: number
  /** "old -> new": count */
  transitions: Record<string, number>
  /** Sheet status words this database does not know, with counts (those rows are left alone). */
  unknown_statuses: Record<string, number>
}

export interface StatusChange {
  contact_id: number
  email: string
  from: string
  to: string
}

/** What would change, read-only. Later rows for the same email win (like a re-sort in the Sheet). */
export async function planStatusSync(q: Queryable, rows: Record<string, string>[]): Promise<{ stats: StatusSyncStats; changes: StatusChange[] }> {
  const stats: StatusSyncStats = {
    rows: rows.length, skipped_no_email: 0, not_in_database: 0, unknown_status: 0, unchanged: 0, changed: 0, transitions: {}, unknown_statuses: {},
  }
  const wanted = new Map<string, string>()
  for (const row of rows) {
    const email = normalizeEmail(row.email)
    if (!email) {
      stats.skipped_no_email++
      continue
    }
    const raw = (row.status ?? '').trim()
    const status = sheetStatus(raw)
    if (!status) {
      if (raw) {
        stats.unknown_status++
        stats.unknown_statuses[raw] = (stats.unknown_statuses[raw] ?? 0) + 1
      } else {
        stats.unchanged++ // a blank Sheet status never clears the database's
      }
      continue
    }
    wanted.set(email, status)
  }
  const changes: StatusChange[] = []
  const emails = [...wanted.keys()]
  const found = new Set<string>()
  for (let i = 0; i < emails.length; i += 1000) {
    const part = emails.slice(i, i + 1000)
    const res = await q.query<{ id: number; email_norm: string; status: string }>(
      'select id, email_norm, status from lp.contacts where email_norm = any($1::text[])',
      [part],
    )
    for (const c of res.rows) {
      found.add(c.email_norm)
      const to = wanted.get(c.email_norm)!
      if (c.status === to) {
        stats.unchanged++
      } else {
        changes.push({ contact_id: c.id, email: c.email_norm, from: c.status, to })
        const key = `${c.status} -> ${to}`
        stats.transitions[key] = (stats.transitions[key] ?? 0) + 1
      }
    }
  }
  stats.not_in_database = emails.length - found.size
  stats.changed = changes.length
  return { stats, changes }
}

/** Write the Sheet's status where it differs. Runs in one transaction as `actor`. */
export async function syncContactStatuses(
  db: Db,
  rows: Record<string, string>[],
  opts: { actor: string; dryRun: boolean; label?: string },
): Promise<StatusSyncStats> {
  if (opts.dryRun) return (await planStatusSync(db, rows)).stats
  return db.tx(async (q) => {
    const { stats, changes } = await planStatusSync(q, rows)
    if (!changes.length) return stats
    await q.query(
      `update lp.contacts c set status = v.to_status,
              do_not_contact = c.do_not_contact or v.to_status = 'do-not-contact'
         from unnest($1::bigint[], $2::text[]) as v(id, to_status)
        where c.id = v.id`,
      [changes.map((c) => c.contact_id), changes.map((c) => c.to)],
    )
    // Item 1.8: a Sheet-driven move to do-not-contact (or bounced) is also a global
    // suppression, so it is excluded from every campaign's push, not just this one's.
    for (const c of changes) {
      if (c.to === 'do-not-contact' || c.to === 'bounced') {
        await addSuppressionIn(q, opts.actor, {
          email: c.email,
          reason: c.to === 'bounced' ? 'bounced' : 'do_not_contact',
          source: 'import',
          note: `From the Lead Master status sync (${c.from} -> ${c.to})`,
        })
      }
    }
    const summary = Object.entries(stats.transitions).map(([k, n]) => `${n.toLocaleString('en-US')} ${k}`).join(', ')
    await q.query('insert into lp.events (actor, kind, summary, data) values ($1, $2, $3, $4)', [
      opts.actor,
      'import.status_sync',
      `Synced contact statuses from the Lead Master${opts.label ? ` (${opts.label})` : ''}: ${stats.changed.toLocaleString('en-US')} changed (${summary})`,
      JSON.stringify({ stats, changes: changes.map(({ email, from, to }) => ({ email, from, to })) }),
    ])
    return stats
  }, opts.actor)
}
