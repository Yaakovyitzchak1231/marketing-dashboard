/** Shared shapes for the verification waterfall (lib/verify/*). */

/** Our verdict vocabulary (lp.verification_results.verdict). */
export type Verdict = 'valid' | 'invalid' | 'catch_all' | 'unknown' | 'risky' | 'pass'

/** A contact's verification_status (lp.contacts.verification_status). */
export type VerificationStatus = 'unverified' | 'valid' | 'invalid' | 'catch_all' | 'unknown' | 'risky'

export type PaidProvider = 'millionverifier' | 'zerobounce'
export type Provider = 'precheck' | PaidProvider

/** One answer from a paid verifier for one address. */
export interface ProviderCheck {
  provider: PaidProvider
  email: string
  /** The provider's own word, unchanged (ok, catch_all, catch-all, do_not_mail, ...). */
  result: string
  sub_result: string | null
  verdict: Exclude<Verdict, 'pass'>
  /** Did this answer consume a credit (by the vendor's published rules)? */
  billable: boolean
  /** Remaining credits if the provider said so in this response. */
  credits_left: number | null
  /** The response body with any API key removed. */
  raw: Record<string, unknown>
}

/**
 * The provider refused the request as a whole (bad key, no credits, blocked
 * IP, HTTP error). The run stops rather than burning through more contacts.
 */
export class ProviderAccountError extends Error {
  constructor(
    public provider: PaidProvider,
    message: string,
    public raw: Record<string, unknown> | null = null,
  ) {
    super(message)
    this.name = 'ProviderAccountError'
  }
}

export type FetchLike = (input: string, init?: { method?: string; signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text?: () => Promise<string>
}>

export interface ProviderOptions {
  apiKey: string
  fetch?: FetchLike
  /** Seconds the vendor may spend on the SMTP conversation. */
  timeoutSec?: number
}

/** Balance for the provider status card. null fields = the provider did not say. */
export interface ProviderBalance {
  provider: PaidProvider
  key_set: boolean
  credits: number | null
  error: string | null
}
