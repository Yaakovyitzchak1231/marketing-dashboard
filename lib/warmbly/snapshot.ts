/**
 * One read of Warmbly for the dashboard (TAP-118): connection, mailboxes with
 * their warm-up / health fields, campaigns, warm-up totals for the last 14
 * days, and today's send allowance. Pure apart from the client passed in, so
 * it is unit-tested with a fake fetch.
 *
 * Each part is read on its own: one failing endpoint leaves the others on
 * screen and its own error in words, never a blank page or a made-up 0.
 */
import { WarmblyClient, WarmblyError } from './client.ts'
import type { WarmblyAllowance, WarmblyCampaign, WarmblyMailbox, WarmblyMe, WarmblyWarmupAnalytics } from './types.ts'

export type Part<T> = { ok: true; value: T } | { ok: false; error: string; status: number | null }

export interface MailboxRow {
  id: string
  email: string | null
  provider: string | null
  status: string | null
  /** 'on' | 'paused' | 'off', or null when Warmbly did not say. */
  warmup: 'on' | 'paused' | 'off' | null
  /** SPF / DKIM / DMARC as Warmbly reported them; null = not reported. */
  spf: string | null
  dkim: string | null
  dmarc: string | null
  sending: string | null
  sendingReason: string | null
  risk: string | null
  lastSyncedAt: string | null
}

export interface CampaignRow {
  id: string
  name: string | null
  status: string | null
  dailyLimit: number | null
  guardrail: string | null
}

export interface WarmupTotals {
  from: string
  to: string
  sent: number | null
  replied: number | null
  /** Warmbly's own reply_rate for the range, as it sent it (not recomputed). */
  replyRate: number | null
  daysActive: number | null
}

export interface WarmblySnapshot {
  readAt: string
  me: Part<{ organization: string | null; scopes: string[] }>
  mailboxes: Part<{ total: number | null; rows: MailboxRow[]; truncated: boolean }>
  campaigns: Part<{ total: number | null; rows: CampaignRow[]; truncated: boolean }>
  warmup: Part<WarmupTotals>
  allowance: Part<{ used: number | null; allowance: number | null; remaining: number | null; basis: string | null }>
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Warmbly's auth_* columns may be a word ("pass", "fail", "none") or a boolean; keep the word, map booleans to pass/fail. */
function authWord(v: unknown): string | null {
  if (typeof v === 'boolean') return v ? 'pass' : 'fail'
  return str(v)
}

export function mailboxRow(m: WarmblyMailbox): MailboxRow {
  let warmup: MailboxRow['warmup'] = null
  if (typeof m.warmup === 'boolean') warmup = m.warmup ? (m.warmup_paused_at ? 'paused' : 'on') : 'off'
  return {
    id: String(m.id),
    email: str(m.email),
    provider: str(m.provider),
    status: str(m.status),
    warmup,
    spf: authWord(m.auth_spf),
    dkim: authWord(m.auth_dkim),
    dmarc: authWord(m.auth_dmarc),
    sending: str(m.send_lifecycle),
    sendingReason: str(m.send_lifecycle_reason) ?? (m.send_recovery_hold ? str(m.send_recovery_reason) ?? 'send recovery hold' : null),
    risk: str(m.risk_band),
    lastSyncedAt: str(m.last_synced_at),
  }
}

export function campaignRow(c: WarmblyCampaign): CampaignRow {
  return {
    id: String(c.id),
    name: str(c.name),
    status: str(c.status),
    dailyLimit: num(c.daily_limit),
    guardrail: c.guardrail_tripped_at ? str(c.guardrail_reason) ?? 'guardrail tripped' : null,
  }
}

export function warmupTotals(a: WarmblyWarmupAnalytics, from: string, to: string): WarmupTotals {
  const s = a.summary ?? {}
  return { from, to, sent: num(s.total_sent), replied: num(s.total_replied), replyRate: num(s.reply_rate), daysActive: num(s.days_active) }
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10)
}

async function part<T, U>(p: Promise<T>, map: (v: T) => U): Promise<Part<U>> {
  try {
    return { ok: true, value: map(await p) }
  } catch (e) {
    const status = e instanceof WarmblyError ? e.status : null
    return { ok: false, error: (e as Error).message.slice(0, 300), status }
  }
}

const PAGE = 100

export async function readWarmblySnapshot(client: WarmblyClient, now: Date = new Date(), days = 14): Promise<WarmblySnapshot> {
  const to = ymd(now)
  const from = ymd(new Date(now.getTime() - days * 86_400_000))
  const [me, mailboxes, campaigns, warmup, allowance] = await Promise.all([
    part(client.me(), (m: WarmblyMe) => ({ organization: str(m.organization_name), scopes: Array.isArray(m.scopes) ? m.scopes.map(String) : [] })),
    part(client.mailboxes(PAGE), (p) => {
      const rows = (p.data ?? []).map(mailboxRow)
      const total = num(p.pagination?.total)
      return { total, rows, truncated: Boolean(p.pagination?.has_more) }
    }),
    part(client.campaigns(PAGE), (p) => {
      const rows = (p.data ?? []).map(campaignRow)
      const total = num(p.pagination?.total)
      return { total, rows, truncated: Boolean(p.pagination?.has_more) }
    }),
    part(client.warmup(from, to), (a) => warmupTotals(a, from, to)),
    part(client.allowance(), (a: WarmblyAllowance) => ({ used: num(a.used), allowance: num(a.allowance), remaining: num(a.remaining), basis: str(a.basis) })),
  ])
  return { readAt: now.toISOString(), me, mailboxes, campaigns, warmup, allowance }
}
