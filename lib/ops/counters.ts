/**
 * The ONE definition of the two counters the shell, Overview, Activity, Agents and the weekly
 * report all show. Each screen used to write its own SQL: Overview and the weekly report counted
 * every approval still marked 'pending', including ones past their expiry (which getApproval
 * would expire the moment anyone opened them), while Activity counted only live ones; so the
 * same moment showed two different "need your OK" numbers. Import these; never re-type them.
 */

/** An approval that still needs a decision: pending AND not past its expiry. Alias `ap`. */
export const PENDING_APPROVAL_SQL = `ap.status = 'pending' and (ap.expires_at is null or ap.expires_at > now())`

/** A notification its recipient has not read yet. Alias `n`; the recipient is bound by the caller. */
export const UNREAD_NOTIFICATION_SQL = `n.read_at is null`

/** `select count(*)` of pending approvals, as a scalar subquery. */
export const PENDING_APPROVALS_COUNT_SQL = `(select count(*)::int from lp.approvals ap where ${PENDING_APPROVAL_SQL})`

/** `select count(*)` of unread notifications for the actor in `recipientExpr` (a column or a $n). */
export function unreadCountSql(recipientExpr: string): string {
  return `(select count(*)::int from lp.notifications n where n.recipient = ${recipientExpr} and ${UNREAD_NOTIFICATION_SQL})`
}
