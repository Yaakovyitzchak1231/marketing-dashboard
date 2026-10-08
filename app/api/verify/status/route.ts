/**
 * GET /api/verify/status -> { providers: { millionverifier, zerobounce }: { key_set, credits, error },
 *                             pricing, counts: { total, by_status } | null }
 * Balances are read server-side; keys never reach the browser.
 */
import { NextResponse } from 'next/server'
import { providerBalances, verificationCounts } from '@/lib/verify/overview'
import { getPricing } from '@/lib/verify/pricing'
import { dbOrNull, fail, NO_STORE } from '../_shared'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const db = dbOrNull()
    const [providers, counts] = await Promise.all([providerBalances(), db ? verificationCounts(db) : Promise.resolve(null)])
    return NextResponse.json({ providers, pricing: getPricing(), counts }, { headers: NO_STORE })
  } catch (e) {
    return fail(e)
  }
}
