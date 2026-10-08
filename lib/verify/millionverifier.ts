/**
 * MillionVerifier single-address client (API v3).
 *
 * Read from developer.millionverifier.com (OpenAPI 3.1.0), Oct 8 2026:
 *   GET https://api.millionverifier.com/api/v3/?api=KEY&email=ADDR&timeout=2..60
 *   -> { email, quality: ''|good|bad|risky, result: ok|catch_all|unknown|error|disposable|invalid,
 *        resultcode: 1..6, subresult, free, role, didyoumean, credits, executiontime, error, livemode }
 *   GET https://api.millionverifier.com/api/v3/credits?api=KEY
 *   -> { credits, bulk_credits, renewing_credits, plan }
 *
 * The key travels only in the request URL; it is never logged, never stored
 * (raw payloads are redacted) and never appears in thrown error text.
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

export const MV_BASE = 'https://api.millionverifier.com/api/v3/'

/** Provider word -> our verdict. */
export const MV_VERDICT: Record<string, Exclude<Verdict, 'pass'>> = {
  ok: 'valid',
  catch_all: 'catch_all',
  unknown: 'unknown',
  disposable: 'invalid',
  invalid: 'invalid',
}

/** These MV words send the address on to ZeroBounce. */
export const MV_ESCALATE = new Set(['catch_all', 'unknown'])

// Error text that means the account (not this address) is the problem.
const ACCOUNT_ERROR = /api ?key|apikey|credit|ip.*block|blocked|insufficient|unauthori[sz]ed|forbidden/i

function getFetch(f?: FetchLike): FetchLike {
  if (f) return f
  return globalThis.fetch as unknown as FetchLike
}

export async function mvVerify(email: string, opts: ProviderOptions): Promise<ProviderCheck> {
  const { apiKey } = opts
  if (!apiKey) throw new ProviderAccountError('millionverifier', 'MillionVerifier key not set')
  const timeout = Math.min(60, Math.max(2, Math.round(opts.timeoutSec ?? 20)))
  const url = `${MV_BASE}?api=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}&timeout=${timeout}`
  const secrets = [apiKey, encodeURIComponent(apiKey)]
  let res: Awaited<ReturnType<FetchLike>>
  try {
    res = await getFetch(opts.fetch)(url, { method: 'GET', signal: AbortSignal.timeout((timeout + 10) * 1000) })
  } catch (e) {
    throw new ProviderAccountError('millionverifier', redactText(`MillionVerifier did not answer: ${(e as Error).message}`, secrets))
  }
  let body: Record<string, unknown> = {}
  try {
    body = ((await res.json()) ?? {}) as Record<string, unknown>
  } catch {
    body = {}
  }
  const raw = redactRaw(body, secrets)
  if (!res.ok) {
    throw new ProviderAccountError('millionverifier', `MillionVerifier answered HTTP ${res.status}`, raw)
  }
  const result = typeof body.result === 'string' ? body.result : ''
  const errorText = typeof body.error === 'string' ? body.error.trim() : ''
  if ((errorText && ACCOUNT_ERROR.test(errorText)) || (!result && errorText)) {
    throw new ProviderAccountError('millionverifier', redactText(`MillionVerifier: ${errorText}`, secrets), raw)
  }
  const credits = typeof body.credits === 'number' ? body.credits : null
  const sub = typeof body.subresult === 'string' && body.subresult ? body.subresult : null
  if (result === 'error' || !(result in MV_VERDICT)) {
    // A per-address failure (e.g. internal error). Recorded, not billed by our
    // estimate, and the contact keeps its previous status.
    return {
      provider: 'millionverifier',
      email,
      result: result || 'error',
      sub_result: sub ?? (errorText || null),
      verdict: 'unknown',
      billable: false,
      credits_left: credits,
      raw,
    }
  }
  return {
    provider: 'millionverifier',
    email,
    result,
    sub_result: sub,
    verdict: MV_VERDICT[result],
    billable: true,
    credits_left: credits,
    raw,
  }
}

export async function mvCredits(apiKey: string | undefined, fetchImpl?: FetchLike): Promise<ProviderBalance> {
  if (!apiKey) return { provider: 'millionverifier', key_set: false, credits: null, error: null }
  const secrets = [apiKey, encodeURIComponent(apiKey)]
  try {
    const res = await getFetch(fetchImpl)(`${MV_BASE}credits?api=${encodeURIComponent(apiKey)}`, {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    })
    const body = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
    if (!res.ok) return { provider: 'millionverifier', key_set: true, credits: null, error: `HTTP ${res.status}` }
    if (typeof body.error === 'string' && body.error) {
      return { provider: 'millionverifier', key_set: true, credits: null, error: redactText(body.error, secrets) }
    }
    return {
      provider: 'millionverifier',
      key_set: true,
      credits: typeof body.credits === 'number' ? body.credits : null,
      error: null,
    }
  } catch (e) {
    return { provider: 'millionverifier', key_set: true, credits: null, error: redactText((e as Error).message, secrets) }
  }
}
