/** Read-only numbers for the /verify screen. Every figure is a stored row or a provider's answer. */
import type { Queryable } from '@/lib/db/types'
import { mvCredits } from './millionverifier'
import { zbCredits } from './zerobounce'
import type { FetchLike, ProviderBalance } from './types'

export const VERIFICATION_STATUSES = ['unverified', 'valid', 'invalid', 'catch_all', 'unknown', 'risky'] as const

/** Contacts with an email, by verification_status. Statuses with no rows are 0 (a count of rows is a measurement). */
export async function verificationCounts(q: Queryable): Promise<{ total: number; by_status: Record<string, number> }> {
  const { rows } = await q.query<{ verification_status: string; n: number }>(
    `select verification_status, count(*)::int as n from lp.contacts where email_norm is not null group by 1`,
  )
  const by: Record<string, number> = Object.fromEntries(VERIFICATION_STATUSES.map((s) => [s, 0]))
  let total = 0
  for (const r of rows) {
    by[r.verification_status] = Number(r.n)
    total += Number(r.n)
  }
  return { total, by_status: by }
}

/** Key set? Balance? Fetched server-side; the keys never reach the browser. */
export async function providerBalances(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: FetchLike,
): Promise<{ millionverifier: ProviderBalance; zerobounce: ProviderBalance }> {
  const [mv, zb] = await Promise.all([
    mvCredits(env.MILLIONVERIFIER_API_KEY?.trim() || undefined, fetchImpl),
    zbCredits(env.ZEROBOUNCE_API_KEY?.trim() || undefined, fetchImpl),
  ])
  return { millionverifier: mv, zerobounce: zb }
}
