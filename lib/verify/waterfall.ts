/**
 * The verification waterfall for ONE address:
 *
 *   free precheck  ->  MillionVerifier (if the precheck did not reject it)
 *                  ->  ZeroBounce (only if MillionVerifier said catch_all or unknown)
 *
 * This file decides; lib/verify/runs.ts writes. Nothing here touches the
 * database, so the decision rules are easy to test.
 */
import { mvVerify, MV_ESCALATE } from './millionverifier'
import { zbVerify } from './zerobounce'
import type { Prechecker, PrecheckResult } from './precheck'
import type { Pricing } from './pricing'
import { usd4 } from './pricing'
import { ProviderAccountError, type FetchLike, type Provider, type VerificationStatus, type Verdict } from './types'

export interface StepRecord {
  provider: Provider
  result: string
  verdict: Verdict
  sub_result: string | null
  cost_usd: number
  raw: Record<string, unknown> | null
}

export interface WaterfallKeys {
  millionverifier?: string | null
  zerobounce?: string | null
}

export interface WaterfallCtx {
  prechecker: Prechecker
  keys: WaterfallKeys
  pricing: Pricing
  fetch?: FetchLike
  mvTimeoutSec?: number
  zbTimeoutSec?: number
}

export type WaterfallStop =
  | 'precheck_invalid'
  | 'mv_key_missing'
  | 'zb_key_missing'
  | 'mv_error'
  | 'account_error'

export interface WaterfallOutcome {
  email: string
  /** Steps taken in this call (the precheck is included only if it ran here). */
  steps: StepRecord[]
  precheck: PrecheckResult
  /** The contact's new verification_status, or null = leave the contact as it is. */
  final: VerificationStatus | null
  /** Which tier decided `final`. */
  decided_by: Provider | null
  cost_usd: number
  /** Why the waterfall ended before ZeroBounce, when it did. */
  stop: WaterfallStop | null
  /** Plain words for the stop ("MillionVerifier key not set"). */
  note: string | null
  /** Set when a provider refused the account (bad key, no credits): the run must halt. */
  account_error: ProviderAccountError | null
}

export function precheckStep(p: PrecheckResult): StepRecord {
  const subs = [
    p.flags.role ? 'role' : null,
    p.flags.free_provider ? 'free_provider' : null,
    p.flags.implicit_mx ? 'a_record_only' : null,
  ].filter(Boolean)
  return {
    provider: 'precheck',
    result: p.result,
    verdict: p.verdict,
    sub_result: subs.length ? subs.join(',') : null,
    cost_usd: 0,
    raw: { domain: p.domain, mx: p.mx, flags: p.flags },
  }
}

/** Worst-case paid cost of running one address through the waterfall with these keys. */
export function worstCaseCost(keys: WaterfallKeys, pricing: Pricing): number {
  if (!keys.millionverifier) return 0
  return usd4(pricing.mvCostPerCheck + (keys.zerobounce ? pricing.zbCostPerCheck : 0))
}

/**
 * Run one address through the waterfall. `pre` is the precheck already done
 * at preview time (so the free check is not repeated); without it the
 * precheck runs here and is included in `steps`.
 */
export async function runWaterfall(
  email: string,
  ctx: WaterfallCtx,
  pre?: PrecheckResult,
  /** MillionVerifier's earlier catch_all/unknown answer: skip MV, go straight to ZeroBounce. */
  priorMv?: 'catch_all' | 'unknown' | null,
): Promise<WaterfallOutcome> {
  const steps: StepRecord[] = []
  let precheck = pre
  if (!precheck) {
    precheck = await ctx.prechecker.check(email)
    steps.push(precheckStep(precheck))
  }
  const base = { email, steps, precheck, account_error: null as ProviderAccountError | null }

  if (precheck.verdict === 'invalid') {
    return { ...base, final: 'invalid', decided_by: 'precheck', cost_usd: 0, stop: 'precheck_invalid', note: null }
  }

  if (priorMv) {
    return zbTier(email, ctx, base, priorMv, 0, true)
  }

  // Tier 2: MillionVerifier.
  if (!ctx.keys.millionverifier) {
    return { ...base, final: null, decided_by: null, cost_usd: 0, stop: 'mv_key_missing', note: 'MillionVerifier key not set' }
  }
  let mv
  try {
    mv = await mvVerify(email, { apiKey: ctx.keys.millionverifier, fetch: ctx.fetch, timeoutSec: ctx.mvTimeoutSec ?? 10 })
  } catch (e) {
    if (e instanceof ProviderAccountError) {
      return { ...base, final: null, decided_by: null, cost_usd: 0, stop: 'account_error', note: e.message, account_error: e }
    }
    throw e
  }
  const mvCost = mv.billable ? ctx.pricing.mvCostPerCheck : 0
  steps.push({ provider: 'millionverifier', result: mv.result, verdict: mv.verdict, sub_result: mv.sub_result, cost_usd: mvCost, raw: mv.raw })
  if (!mv.billable) {
    // MillionVerifier answered `error` for this address: leave the contact alone.
    return { ...base, final: null, decided_by: null, cost_usd: 0, stop: 'mv_error', note: `MillionVerifier could not check it (${mv.sub_result ?? mv.result})` }
  }
  if (!MV_ESCALATE.has(mv.result)) {
    return { ...base, final: mv.verdict as VerificationStatus, decided_by: 'millionverifier', cost_usd: usd4(mvCost), stop: null, note: null }
  }

  // Tier 3: ZeroBounce, only for MV catch_all / unknown.
  return zbTier(email, ctx, base, mv.verdict as 'catch_all' | 'unknown', mvCost, false)
}

async function zbTier(
  email: string,
  ctx: WaterfallCtx,
  base: Pick<WaterfallOutcome, 'email' | 'steps' | 'precheck' | 'account_error'>,
  mvFinal: 'catch_all' | 'unknown',
  mvCost: number,
  fromEarlierMv: boolean,
): Promise<WaterfallOutcome> {
  const steps = base.steps
  if (!ctx.keys.zerobounce) {
    return {
      ...base,
      // An earlier MV answer is already on the contact: nothing new to write.
      final: fromEarlierMv ? null : mvFinal,
      decided_by: fromEarlierMv ? null : 'millionverifier',
      cost_usd: usd4(mvCost),
      stop: 'zb_key_missing',
      note: 'ZeroBounce key not set',
    }
  }
  let zb
  try {
    zb = await zbVerify(email, { apiKey: ctx.keys.zerobounce, fetch: ctx.fetch, timeoutSec: ctx.zbTimeoutSec ?? 15 })
  } catch (e) {
    if (e instanceof ProviderAccountError) {
      // MillionVerifier's answer stands; the run halts on ZeroBounce's refusal.
      return {
        ...base,
        final: fromEarlierMv ? null : mvFinal,
        decided_by: fromEarlierMv ? null : 'millionverifier',
        cost_usd: usd4(mvCost),
        stop: 'account_error',
        note: e.message,
        account_error: e,
      }
    }
    throw e
  }
  const zbCost = zb.billable ? ctx.pricing.zbCostPerCheck : 0
  steps.push({ provider: 'zerobounce', result: zb.result, verdict: zb.verdict, sub_result: zb.sub_result, cost_usd: zbCost, raw: zb.raw })
  // ZeroBounce `unknown` tells us nothing new (and is free): MillionVerifier's word stands.
  const zbDecides = zb.verdict !== 'unknown'
  return {
    ...base,
    final: zbDecides ? (zb.verdict as VerificationStatus) : mvFinal,
    decided_by: zbDecides ? 'zerobounce' : 'millionverifier',
    cost_usd: usd4(mvCost + zbCost),
    stop: null,
    note: null,
  }
}

/** Statuses that mean "not yet in a campaign": the only ones verification may move. */
export const PRE_SEND_STATUSES = new Set(['new', 'verifying', 'valid-ready', 'catch-all-hold', 'guessed-hold'])

/**
 * The contact's sheet-vocabulary status after a verdict. Anything already in
 * Instantly / sent / replied / bounced / do-not-contact is never moved by a
 * verification result (its verification_status still updates).
 */
export function nextContactStatus(current: string, verdict: VerificationStatus | null): string {
  if (!verdict || !PRE_SEND_STATUSES.has(current)) return current
  switch (verdict) {
    case 'valid':
      return current === 'valid-ready' ? current : 'valid-ready'
    case 'invalid':
      return 'rejected'
    case 'catch_all':
      return 'catch-all-hold'
    default:
      return current
  }
}
