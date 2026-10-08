/**
 * Deliverability: per-sending-account health (classifyAccountHealth uses the
 * same findings, so the sender table and the callouts never disagree) and the
 * workspace-wide bounce rate.
 */
import type { AccountHealth, SenderAccount } from '@/lib/dashboard/types'
import {
  BOUNCE_CRITICAL,
  BOUNCE_WARN,
  LOAD_MULTIPLE_OF_MEDIAN,
  MIN_ACCOUNTS_FOR_LOAD_CHECK,
  MIN_SENT_FOR_ACCOUNT_BOUNCE,
  MIN_SENT_FOR_LOAD_CHECK,
  MIN_SENT_FOR_TOTAL_BOUNCE,
  WARMUP_AT_RISK,
  WARMUP_WATCH,
} from './thresholds'
import { median, num, ofN, pct, rate } from './stats'
import { RULE_IMPACT, mag, type InsightInput, type RankedInsight } from './types'

export type AccountInput = Omit<SenderAccount, 'health' | 'healthReason'>

type StatusKind = 'error' | 'paused' | 'active' | 'other'

/**
 * Instantly v2 reports account status as a code (1 active, 2 paused, -1/-2/-3
 * connection / soft-bounce / sending errors); the data layer passes a word.
 * We read the word loosely so either "error" or "connection_error" or "-1" works.
 */
export function statusKind(status: string | null | undefined): StatusKind {
  const s = String(status ?? '').trim().toLowerCase()
  if (!s) return 'other'
  if (/^-\d/.test(s) || /error|disconnect|fail|invalid|suspend|banned|bounce/.test(s)) return 'error'
  if (/pause|inactive|disabled|stopped/.test(s) || s === '2') return 'paused'
  if (/active|connected|ok|enabled/.test(s) || s === '1') return 'active'
  return 'other'
}

export type FindingCode = 'status_error' | 'bounce' | 'warmup' | 'paused'

export interface AccountFinding {
  code: FindingCode
  level: 'watch' | 'at_risk'
  reason: string
  /** For bounce findings: the rate and counts behind it. */
  bounceRate?: number
}

/** The account's bounce rate if it has enough sends to be judged, else null. */
export function judgedBounceRate(a: AccountInput): number | null {
  if (a.sent == null || a.sent < MIN_SENT_FOR_ACCOUNT_BOUNCE) return null
  const r = rate(a.bounced, a.sent)
  if (r != null) return r
  // Bounced count missing but Instantly gave a rate: use it, only when it is a real rate.
  if (a.bounceRate != null && a.bounceRate >= 0 && a.bounceRate <= 1) return a.bounceRate
  return null
}

function bounceEvidence(a: AccountInput, r: number): string {
  return a.bounced != null && a.sent != null
    ? `${pct(r)} bounce (${ofN(a.bounced, a.sent)} sent)`
    : `${pct(r)} bounce`
}

/** Same evidence without nested parentheses, for lists that wrap each item in ( ). */
function bounceShort(a: AccountInput, r: number): string {
  return a.bounced != null && a.sent != null ? `${pct(r)} bounce, ${ofN(a.bounced, a.sent)} sent` : `${pct(r)} bounce`
}

/** Every rule-level finding about one account, worst first. Pure. */
export function assessAccount(a: AccountInput): AccountFinding[] {
  const out: AccountFinding[] = []
  const kind = statusKind(a.status)
  if (kind === 'error') {
    out.push({ code: 'status_error', level: 'at_risk', reason: `Instantly reports status "${a.status}" (not sending)` })
  }
  const br = judgedBounceRate(a)
  if (br != null && br > BOUNCE_CRITICAL) {
    out.push({ code: 'bounce', level: 'at_risk', bounceRate: br, reason: `${bounceEvidence(a, br)}, over the ${pct(BOUNCE_CRITICAL)} limit` })
  } else if (br != null && br > BOUNCE_WARN) {
    out.push({ code: 'bounce', level: 'watch', bounceRate: br, reason: `${bounceEvidence(a, br)}, over the ${pct(BOUNCE_WARN)} target` })
  }
  if (a.warmupScore != null && a.warmupScore < WARMUP_AT_RISK) {
    out.push({ code: 'warmup', level: 'at_risk', reason: `warmup score ${num(a.warmupScore)} (below ${WARMUP_AT_RISK})` })
  } else if (a.warmupScore != null && a.warmupScore < WARMUP_WATCH) {
    out.push({ code: 'warmup', level: 'watch', reason: `warmup score ${num(a.warmupScore)} (below ${WARMUP_WATCH})` })
  }
  if (kind === 'paused') {
    out.push({ code: 'paused', level: 'watch', reason: `paused in Instantly (status "${a.status}")` })
  }
  return out.sort((x, y) => (x.level === y.level ? 0 : x.level === 'at_risk' ? -1 : 1))
}

/**
 * Pure: classify one sending account.
 *  - at_risk: Instantly error status, bounce > BOUNCE_CRITICAL, or warmup < WARMUP_AT_RISK
 *  - watch:   bounce > BOUNCE_WARN, warmup < WARMUP_WATCH, or paused
 *  - healthy: none of the above AND at least one of (bounce judged on >= MIN_SENT_FOR_ACCOUNT_BOUNCE sends, a warmup score)
 *  - unknown: nothing to judge on
 * healthReason lists every finding in plain words, worst first.
 */
export function classifyAccountHealth(a: AccountInput): { health: AccountHealth; healthReason: string } {
  const findings = assessAccount(a)
  const reasons = findings.map((f) => f.reason)
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  if (findings.some((f) => f.level === 'at_risk')) return { health: 'at_risk', healthReason: cap(reasons.join('; ')) }
  if (findings.length) return { health: 'watch', healthReason: cap(reasons.join('; ')) }

  const br = judgedBounceRate(a)
  const bits: string[] = []
  if (br != null) bits.push(bounceEvidence(a, br))
  if (a.warmupScore != null) bits.push(`warmup ${num(a.warmupScore)}`)
  if (bits.length) return { health: 'healthy', healthReason: cap(bits.join(', ')) }

  if (a.sent != null && a.sent > 0) {
    return { health: 'unknown', healthReason: `Only ${num(a.sent)} sent, too few to judge bounce (needs ${MIN_SENT_FOR_ACCOUNT_BOUNCE}), and no warmup score` }
  }
  return { health: 'unknown', healthReason: 'No sends in this period and no warmup score to judge' }
}

/* ---------- callouts ---------- */

const MAX_LISTED = 5

/** "a (why); b (why)". With collapse, a single item is just its reason (the card title already names the account). */
function listAccounts(items: { email: string; why: string }[], collapse = false): string {
  if (collapse && items.length === 1) return items[0].why.charAt(0).toUpperCase() + items[0].why.slice(1)
  const shown = items.slice(0, MAX_LISTED).map((i) => `${i.email} (${i.why})`)
  const more = items.length - shown.length
  return shown.join('; ') + (more > 0 ? `; and ${more} more` : '')
}

function accountEntity(email: string) {
  return { kind: 'account' as const, id: email, name: email }
}

export function deliverabilityInsights(d: InsightInput): RankedInsight[] {
  const out: RankedInsight[] = []

  // 1. Workspace-wide bounce rate: bounced / sent over the period.
  const tc = d.totals.counts
  if (tc.sent != null && tc.sent >= MIN_SENT_FOR_TOTAL_BOUNCE) {
    const r = rate(tc.bounced, tc.sent)
    if (r != null && r > BOUNCE_WARN) {
      const critical = r > BOUNCE_CRITICAL
      out.push({
        id: 'bounce-total',
        severity: critical ? 'critical' : 'warning',
        title: `${pct(r)} of emails bounced this period`,
        detail: `${ofN(tc.bounced as number, tc.sent)} emails bounced (${pct(r)}). The target is under ${pct(BOUNCE_WARN)}; above ${pct(BOUNCE_CRITICAL)} inbox providers start sending you to spam.`,
        action: critical
          ? 'Stop uploading unverified leads now: run the remaining list through email verification and remove bounced and catch-all addresses before the next send.'
          : 'Verify the next lead list before upload and remove catch-all addresses.',
        metric: { label: 'Bounce rate', value: pct(r) },
        impact: RULE_IMPACT.totalBounce + mag(r * 1000),
      })
    }
  }

  // 2. Per-account findings, grouped by kind so 12 bad inboxes make one card, not 12.
  const assessed = [...d.accounts]
    .sort((a, b) => a.email.localeCompare(b.email))
    .map((a) => ({ a, f: assessAccount(a) }))

  const group = (code: FindingCode, level: 'watch' | 'at_risk') =>
    assessed
      // Warmup / bounce / paused findings only matter for inboxes an active campaign uses (or unknown).
      .filter(({ a }) => code === 'status_error' || a.inActiveCampaign !== false)
      .map(({ a, f }) => ({ a, hit: f.find((x) => x.code === code && x.level === level) }))
      .filter((x): x is { a: AccountInput & SenderAccount; hit: AccountFinding } => x.hit != null)

  const allErrors = group('status_error', 'at_risk')
  // Errored inboxes that no active campaign uses (old campaigns) are cleanup, not an emergency.
  const unusedErrors = allErrors.filter(({ a }) => a.inActiveCampaign === false)
  const errors = allErrors.filter(({ a }) => a.inActiveCampaign !== false)
  if (unusedErrors.length) {
    const one = unusedErrors.length === 1
    out.push({
      id: 'account-error-unused',
      severity: 'opportunity',
      title: one
        ? `${unusedErrors[0].a.email} has an error, but no active campaign uses it`
        : `${unusedErrors.length} inboxes have errors, but no active campaign uses them`,
      detail:
        listAccounts(unusedErrors.map(({ a }) => ({ email: a.email, why: `status "${a.status}"${a.campaigns && a.campaigns.length ? `, only on ${a.campaigns.map((c) => `${c.name} (${c.status})`).join(', ')}` : ', on no campaign'}` }))) +
        '. Nothing you are sending right now depends on them.',
      action: `Decide which to keep: reconnect the ones you will reuse in Instantly > Email Accounts and delete the rest so they stop cluttering health checks.`,
      metric: { label: 'Unused inboxes in error', value: num(unusedErrors.length) },
      impact: RULE_IMPACT.accountPaused + mag(unusedErrors.length),
    })
  }
  if (errors.length) {
    const one = errors.length === 1
    out.push({
      id: one ? `account-error:${errors[0].a.email}` : 'account-error',
      severity: 'critical',
      title: one
        ? `${errors[0].a.email} has an error in Instantly and is not sending`
        : `${errors.length} sending accounts have errors in Instantly`,
      detail: listAccounts(errors.map(({ a }) => ({ email: a.email, why: one ? `Instantly status: "${a.status}". Campaigns skip this inbox until it is reconnected` : `status "${a.status}"` })), one) + '.',
      action: one
        ? `Open ${errors[0].a.email} in Instantly > Email Accounts and reconnect it (re-enter the password or app password, re-authorize OAuth).`
        : 'Open Instantly > Email Accounts, filter by errors, and reconnect each one (re-enter passwords or re-authorize).',
      entity: one ? accountEntity(errors[0].a.email) : undefined,
      impact: RULE_IMPACT.accountError + mag(errors.length),
    })
  }

  for (const level of ['at_risk', 'watch'] as const) {
    const hits = group('bounce', level).sort(
      (x, y) => (y.hit.bounceRate ?? 0) - (x.hit.bounceRate ?? 0) || x.a.email.localeCompare(y.a.email),
    )
    if (!hits.length) continue
    const limit = level === 'at_risk' ? BOUNCE_CRITICAL : BOUNCE_WARN
    const one = hits.length === 1
    const worst = hits[0]
    out.push({
      id: one ? `bounce-${level}:${worst.a.email}` : `bounce-${level}`,
      severity: level === 'at_risk' ? 'critical' : 'warning',
      title: one
        ? `${worst.a.email} is bouncing ${pct(worst.hit.bounceRate ?? 0)} (limit ${pct(limit)})`
        : `${hits.length} sending accounts bounce above ${pct(limit)}`,
      detail:
        listAccounts(hits.map(({ a, hit }) => ({ email: a.email, why: one ? bounceEvidence(a, hit.bounceRate ?? 0) : bounceShort(a, hit.bounceRate ?? 0) })), one) +
        `. Accounts need at least ${MIN_SENT_FOR_ACCOUNT_BOUNCE} sends this period to be judged.`,
      action:
        level === 'at_risk'
          ? `Pause ${one ? 'this account' : 'these accounts'} in the campaigns they send for, and verify the leads they were sending to before resuming.`
          : `Watch ${one ? 'this account' : 'these accounts'}; lower ${one ? 'its' : 'their'} daily limit and verify the leads in ${one ? 'its' : 'their'} campaigns.`,
      metric: { label: 'Worst bounce', value: pct(worst.hit.bounceRate ?? 0) },
      entity: one ? accountEntity(worst.a.email) : undefined,
      impact: RULE_IMPACT.accountBounce + mag((worst.hit.bounceRate ?? 0) * 1000),
    })
  }

  for (const level of ['at_risk', 'watch'] as const) {
    const hits = group('warmup', level).sort(
      (x, y) => (x.a.warmupScore ?? 0) - (y.a.warmupScore ?? 0) || x.a.email.localeCompare(y.a.email),
    )
    if (!hits.length) continue
    const bar = level === 'at_risk' ? WARMUP_AT_RISK : WARMUP_WATCH
    const one = hits.length === 1
    out.push({
      id: one ? `warmup-${level}:${hits[0].a.email}` : `warmup-${level}`,
      severity: level === 'at_risk' ? 'warning' : 'opportunity',
      title: one
        ? `${hits[0].a.email} has a low warmup score (${num(hits[0].a.warmupScore ?? 0)})`
        : `${hits.length} sending accounts have warmup scores under ${bar}`,
      detail: listAccounts(hits.map(({ a }) => ({ email: a.email, why: `warmup ${num(a.warmupScore ?? 0)}` })), one) + `. Lines used here: under ${WARMUP_WATCH} is on watch, under ${WARMUP_AT_RISK} is at risk (Instantly scores 0-100).`,
      action:
        level === 'at_risk'
          ? `Take ${one ? 'it' : 'them'} out of live campaigns and leave warmup running until the score is back above ${WARMUP_WATCH}.`
          : `Keep warmup on and lower ${one ? 'its' : 'their'} daily campaign limit until the score is ${WARMUP_WATCH}+.`,
      entity: one ? accountEntity(hits[0].a.email) : undefined,
      impact: RULE_IMPACT.warmup + (level === 'at_risk' ? 50 : 0) + mag(hits.length),
    })
  }

  const paused = group('paused', 'watch')
  if (paused.length) {
    const one = paused.length === 1
    out.push({
      id: one ? `account-paused:${paused[0].a.email}` : 'account-paused',
      severity: 'opportunity',
      title: one ? `${paused[0].a.email} is paused` : `${paused.length} sending accounts are paused`,
      detail: listAccounts(paused.map(({ a }) => ({ email: a.email, why: one ? `Instantly status: "${a.status}". It sends nothing while paused` : `status "${a.status}"` })), one) + '.',
      action: `Resume ${one ? 'it' : 'them'} if ${one ? 'it' : 'they'} should be sending; otherwise remove ${one ? 'it' : 'them'} from campaigns so the load plan is honest.`,
      entity: one ? accountEntity(paused[0].a.email) : undefined,
      impact: RULE_IMPACT.accountPaused + mag(paused.length),
    })
  }

  // 3. Load balance: one inbox carrying far more than the median sending inbox.
  const sending = assessed.filter(({ a }) => a.sent != null && a.sent > 0)
  if (sending.length >= MIN_ACCOUNTS_FOR_LOAD_CHECK) {
    const med = median(sending.map(({ a }) => a.sent as number))
    const heavy = sending
      .filter(({ a }) => (a.sent as number) >= LOAD_MULTIPLE_OF_MEDIAN * med && (a.sent as number) >= MIN_SENT_FOR_LOAD_CHECK)
      .sort((x, y) => (y.a.sent as number) - (x.a.sent as number) || x.a.email.localeCompare(y.a.email))
    if (heavy.length) {
      const total = sending.reduce((s, { a }) => s + (a.sent as number), 0)
      const risky = heavy.some(({ f }) => f.some((x) => x.code === 'bounce'))
      const one = heavy.length === 1
      out.push({
        id: one ? `load:${heavy[0].a.email}` : 'load',
        severity: risky ? 'warning' : 'opportunity',
        title: one
          ? `${heavy[0].a.email} is carrying ${pct((heavy[0].a.sent as number) / total)} of all sends`
          : `${heavy.length} sending accounts carry most of the volume`,
        detail:
          listAccounts(heavy.map(({ a }) => ({ email: a.email, why: `${num(a.sent as number)} sent, ${((a.sent as number) / med).toFixed(1)}x the median` })), one) +
          `. The median sending account sent ${num(med)} across ${sending.length} accounts that sent this period.` +
          (risky ? ' At least one of them is also over the bounce target.' : ''),
        action: 'Spread the load: add more sending accounts to the busiest campaign or lower the daily limit on the heavy ones.',
        entity: one ? accountEntity(heavy[0].a.email) : undefined,
        impact: RULE_IMPACT.loadBalance + mag(heavy.length),
      })
    }
  }

  // 4. Active accounts that sent nothing while others did.
  if (sending.length > 0) {
    const idle = assessed.filter(({ a }) => a.sent === 0 && statusKind(a.status) === 'active')
    // Warmed-up inboxes attached to no active campaign: spare capacity, said separately.
    const spare = idle.filter(({ a }) => a.inActiveCampaign === false && a.warmupScore != null && a.warmupScore >= WARMUP_WATCH)
    if (spare.length) {
      out.push({
        id: 'accounts-spare',
        severity: 'opportunity',
        title: `${spare.length} warmed-up inbox${spare.length === 1 ? ' is' : 'es are'} not on any active campaign`,
        detail: listAccounts(spare.map(({ a }) => ({ email: a.email, why: `warmup ${num(a.warmupScore ?? 0)}, 0 sent` }))) +
          `. They are healthy and warmed, but nothing is sending from them.`,
        action: 'Attach them to a live campaign that matches their domain (or launch one) to add sending capacity.',
        metric: { label: 'Idle warmed inboxes', value: num(spare.length) },
        impact: RULE_IMPACT.idleAccounts + 10 + mag(spare.length),
      })
    }
    const spareSet = new Set(spare.map(({ a }) => a.email))
    const idleRest = idle.filter(({ a }) => !spareSet.has(a.email))
    if (idleRest.length) {
      const idle = idleRest
      out.push({
        id: 'accounts-idle',
        severity: 'opportunity',
        title: `${idle.length} active sending account${idle.length === 1 ? '' : 's'} sent nothing this period`,
        detail: listAccounts(idle.map(({ a }) => ({ email: a.email, why: `0 sent${a.warmupScore != null ? `, warmup ${num(a.warmupScore)}` : ''}` }))) +
          `, while ${sending.length} other account${sending.length === 1 ? '' : 's'} did send.`,
        action: 'If they are warmed up, add them to a live campaign to raise capacity; if they are still warming, ignore this.',
        impact: RULE_IMPACT.idleAccounts + mag(idle.length),
      })
    }
  }

  return out
}
