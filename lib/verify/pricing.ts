/**
 * What a paid check costs, used ONLY for the cost preview and the run's
 * ceiling. These are estimates from the vendors' public price lists, not
 * billing data: the vendor's own invoice is the truth.
 *
 * MillionVerifier credit packs (millionverifier.com pricing, as read by the build lead Oct 8 2026;
 * millionverifier.com/pricing returned 404 to a direct fetch from this box the same day):
 *   10K $39 ($0.0039/check) · 25K $59 ($0.0024) · 50K $89 ($0.00178)
 *   100K $149 ($0.00149) · 500K $299 ($0.0006) · 1M $449 ($0.00045)
 *
 * ZeroBounce pay-as-you-go (zerobounce.net/email-validation-pricing, read Oct 8 2026; the page's
 * FAQ confirms "Pay as You Go ... starts at $39 USD for validating 2,000 email addresses"):
 *   2K $39 ($0.0195) · 10K $129 ($0.0129) · 50K $499 ($0.00998)
 *   100K $649 ($0.00649) · 1M $3,199 ($0.0032)
 *   ZeroBounce: "we won't charge you for checking them" for `unknown` results
 *   (pricing FAQ) and the validate docs: "will never consume a credit for any
 *   unknown result".
 *
 * Defaults are the per-check price of the pack size Yaakov is likely on
 * (MV 10K, ZB 10K); override with env when he buys a different pack.
 *
 * ZB escalation share: the fraction of MillionVerifier checks expected to come
 * back catch_all or unknown (and so go on to ZeroBounce). Default 0.25 from his
 * own MillionVerifier history: catch_all 19.5% + unknown 5.9% on 14,898 checks.
 */

export const MV_PACKS = [
  { credits: 10_000, usd: 39 },
  { credits: 25_000, usd: 59 },
  { credits: 50_000, usd: 89 },
  { credits: 100_000, usd: 149 },
  { credits: 500_000, usd: 299 },
  { credits: 1_000_000, usd: 449 },
] as const

export const ZB_PACKS = [
  { credits: 2_000, usd: 39 },
  { credits: 10_000, usd: 129 },
  { credits: 50_000, usd: 499 },
  { credits: 100_000, usd: 649 },
  { credits: 1_000_000, usd: 3_199 },
] as const

export const DEFAULT_MV_COST_PER_CHECK = 0.0039
export const DEFAULT_ZB_COST_PER_CHECK = 0.0129
export const DEFAULT_ZB_SHARE_ESTIMATE = 0.25

export interface Pricing {
  mvCostPerCheck: number
  zbCostPerCheck: number
  /** 0..1: expected share of MV checks that escalate to ZeroBounce. */
  zbShareEstimate: number
  /** Where each number came from: 'default' or the env var name. */
  source: { mv: string; zb: string; share: string }
}

function envNumber(env: Record<string, string | undefined>, name: string, min: number, max: number): number | null {
  const raw = env[name]
  if (raw == null || raw.trim() === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n < min || n > max) return null
  return n
}

export function getPricing(env: Record<string, string | undefined> = process.env): Pricing {
  const mv = envNumber(env, 'MV_COST_PER_CHECK', 0, 1)
  const zb = envNumber(env, 'ZB_COST_PER_CHECK', 0, 1)
  const share = envNumber(env, 'VERIFY_ZB_SHARE_ESTIMATE', 0, 1)
  return {
    mvCostPerCheck: mv ?? DEFAULT_MV_COST_PER_CHECK,
    zbCostPerCheck: zb ?? DEFAULT_ZB_COST_PER_CHECK,
    zbShareEstimate: share ?? DEFAULT_ZB_SHARE_ESTIMATE,
    source: {
      mv: mv == null ? 'default' : 'MV_COST_PER_CHECK',
      zb: zb == null ? 'default' : 'ZB_COST_PER_CHECK',
      share: share == null ? 'default' : 'VERIFY_ZB_SHARE_ESTIMATE',
    },
  }
}

/** Round a dollar amount to 4 decimals (the precision lp.verification_runs stores). */
export function usd4(n: number): number {
  return Math.round(n * 10_000) / 10_000
}

export interface CostEstimate {
  mv_checks: number
  /** Of zb_checks, how many go straight to ZeroBounce because MillionVerifier already answered catch_all/unknown. */
  zb_direct: number
  zb_checks: number
  mv_cost_usd: number
  zb_cost_usd: number
  total_usd: number
  mv_cost_per_check: number
  zb_cost_per_check: number
  zb_share: number
  /** The math, in words, for the preview card. */
  math: string
}

/**
 * The preview estimate. Every contact that passes the free check costs one
 * MillionVerifier check, except `zbDirect` contacts MillionVerifier already
 * answered catch_all/unknown (they go straight to ZeroBounce); ZeroBounce
 * checks are estimated as ceil(mv_checks x share) + zbDirect. Nothing here is
 * a measurement.
 */
export function estimateCost(precheckPass: number, p: Pricing, zbDirect = 0): CostEstimate {
  const direct = Math.max(0, Math.min(Math.floor(zbDirect), Math.floor(precheckPass)))
  const mv = Math.max(0, Math.floor(precheckPass) - direct)
  const zbEscalated = Math.ceil(mv * p.zbShareEstimate)
  const zb = zbEscalated + direct
  const mvCost = usd4(mv * p.mvCostPerCheck)
  const zbCost = usd4(zb * p.zbCostPerCheck)
  const total = usd4(mvCost + zbCost)
  const pct = Math.round(p.zbShareEstimate * 1000) / 10
  return {
    mv_checks: mv,
    zb_direct: direct,
    zb_checks: zb,
    mv_cost_usd: mvCost,
    zb_cost_usd: zbCost,
    total_usd: total,
    mv_cost_per_check: p.mvCostPerCheck,
    zb_cost_per_check: p.zbCostPerCheck,
    zb_share: p.zbShareEstimate,
    math:
      `${mv} × $${p.mvCostPerCheck} = $${mvCost.toFixed(4)} (MillionVerifier) + ` +
      `${direct ? `(${zbEscalated} (≈${pct}% of ${mv}) + ${direct} already catch-all/unknown at MillionVerifier)` : `${zb} (≈${pct}% of ${mv})`} × $${p.zbCostPerCheck} = $${zbCost.toFixed(4)} (ZeroBounce) = $${total.toFixed(4)}`,
  }
}

/** Round up to the next whole cent. */
export function ceilCents(n: number): number {
  return Math.ceil(n * 100 - 1e-9) / 100
}

/**
 * The ceiling the approve box suggests: the estimate plus 20% headroom
 * (ZeroBounce's real share varies, and each contact reserves its worst case
 * before it starts). '' when there is no estimate. The human can change it.
 */
export function suggestCeiling(estimateUsd: number | null | undefined): string {
  if (estimateUsd == null || !Number.isFinite(estimateUsd)) return ''
  return String(ceilCents(estimateUsd * 1.2))
}

/** Parse the ceiling box. null = not a usable dollar amount. */
export function parseCeiling(text: string): number | null {
  const t = text.trim().replace(/^\$/, '')
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 ? n : null
}
