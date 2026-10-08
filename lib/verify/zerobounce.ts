/**
 * ZeroBounce single-address client (API v2).
 *
 * Read from zerobounce.net/docs (v2 validate, v2 status codes, v2 credit balance), Oct 8 2026:
 *   GET https://api.zerobounce.net/v2/validate?api_key=KEY&email=ADDR&ip_address=&timeout=3..60
 *   -> { address, status, sub_status, free_email, catchall_domain, did_you_mean, mx_found, ... }
 *      status: valid | invalid | catch-all | unknown | spamtrap | abuse | do_not_mail
 *      error:  {"error":"Invalid API Key or your account ran out of credits"}
 *      "will never consume a credit for any unknown result"
 *   GET https://api.zerobounce.net/v2/getcredits?api_key=KEY -> {"Credits":2375323}, -1 = invalid key
 */
import { redactRaw, redactText } from './redact'
import {
  ProviderAccountError,
  type FetchLike,
  type ProviderBalance,
  type ProviderCheck,
  type ProviderOptions,
  type Verdict,
} from './types'

export const ZB_BASE = 'https://api.zerobounce.net/v2/'

/**
 * Provider word -> our verdict.
 *
 * do_not_mail is not a dead mailbox: ZeroBounce uses it for role addresses
 * (info@, sales@ -- most jeweler leads), so it maps to `risky` (held for a
 * human), except the sub-statuses that are genuinely unmailable (below).
 */
export const ZB_VERDICT: Record<string, Exclude<Verdict, 'pass'>> = {
  valid: 'valid',
  invalid: 'invalid',
  'catch-all': 'catch_all',
  unknown: 'unknown',
  spamtrap: 'invalid',
  abuse: 'risky',
  do_not_mail: 'risky',
}

const DO_NOT_MAIL_INVALID = new Set(['disposable', 'toxic', 'global_suppression', 'possible_trap', 'mx_forward'])

function getFetch(f?: FetchLike): FetchLike {
  if (f) return f
  return globalThis.fetch as unknown as FetchLike
}

export function zbVerdict(status: string, subStatus: string | null): Exclude<Verdict, 'pass'> | null {
  if (!(status in ZB_VERDICT)) return null
  if (status === 'do_not_mail' && subStatus && DO_NOT_MAIL_INVALID.has(subStatus)) return 'invalid'
  return ZB_VERDICT[status]
}

export async function zbVerify(email: string, opts: ProviderOptions): Promise<ProviderCheck> {
  const { apiKey } = opts
  if (!apiKey) throw new ProviderAccountError('zerobounce', 'ZeroBounce key not set')
  const timeout = Math.min(60, Math.max(3, Math.round(opts.timeoutSec ?? 30)))
  const url =
    `${ZB_BASE}validate?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}` +
    `&ip_address=&timeout=${timeout}`
  const secrets = [apiKey, encodeURIComponent(apiKey)]
  let res: Awaited<ReturnType<FetchLike>>
  try {
    res = await getFetch(opts.fetch)(url, { method: 'GET', signal: AbortSignal.timeout((timeout + 10) * 1000) })
  } catch (e) {
    throw new ProviderAccountError('zerobounce', redactText(`ZeroBounce did not answer: ${(e as Error).message}`, secrets))
  }
  let body: Record<string, unknown> = {}
  try {
    body = ((await res.json()) ?? {}) as Record<string, unknown>
  } catch {
    body = {}
  }
  const raw = redactRaw(body, secrets)
  if (!res.ok) throw new ProviderAccountError('zerobounce', `ZeroBounce answered HTTP ${res.status}`, raw)
  if (typeof body.error === 'string' && body.error) {
    throw new ProviderAccountError('zerobounce', redactText(`ZeroBounce: ${body.error}`, secrets), raw)
  }
  const status = typeof body.status === 'string' ? body.status : ''
  const sub = typeof body.sub_status === 'string' && body.sub_status ? body.sub_status : null
  const verdict = zbVerdict(status, sub)
  if (!verdict) {
    return {
      provider: 'zerobounce',
      email,
      result: status || 'error',
      sub_result: sub,
      verdict: 'unknown',
      billable: false,
      credits_left: null,
      raw,
    }
  }
  return {
    provider: 'zerobounce',
    email,
    result: status,
    sub_result: sub,
    verdict,
    // ZeroBounce: "will never consume a credit for any unknown result".
    billable: status !== 'unknown',
    credits_left: null,
    raw,
  }
}

export async function zbCredits(apiKey: string | undefined, fetchImpl?: FetchLike): Promise<ProviderBalance> {
  if (!apiKey) return { provider: 'zerobounce', key_set: false, credits: null, error: null }
  const secrets = [apiKey, encodeURIComponent(apiKey)]
  try {
    const res = await getFetch(fetchImpl)(`${ZB_BASE}getcredits?api_key=${encodeURIComponent(apiKey)}`, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    })
    const body = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
    if (!res.ok) return { provider: 'zerobounce', key_set: true, credits: null, error: `HTTP ${res.status}` }
    const c = typeof body.Credits === 'number' ? body.Credits : typeof body.Credits === 'string' ? Number(body.Credits) : NaN
    if (!Number.isFinite(c)) return { provider: 'zerobounce', key_set: true, credits: null, error: 'no balance in the answer' }
    if (c === -1) return { provider: 'zerobounce', key_set: true, credits: null, error: 'ZeroBounce says the key is invalid' }
    return { provider: 'zerobounce', key_set: true, credits: c, error: null }
  } catch (e) {
    return { provider: 'zerobounce', key_set: true, credits: null, error: redactText((e as Error).message, secrets) }
  }
}
