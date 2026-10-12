/**
 * GET /api/verify/status -> { providers: { millionverifier, zerobounce }: { key_set, credits, error },
 *                             pricing, counts: { total, by_status } | null }
 * Balances are read server-side; keys never reach the browser. Editor role or above.
 */
import { NextResponse } from 'next/server'
import { providerBalancesAsync, verificationCounts } from '@/lib/verify/overview'
import { getPricing } from '@/lib/verify/pricing'
import { actorFor } from '@/lib/auth/act'
import { dbOrNull, fail, NO_STORE } from '../_shared'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    // Spend and balances: editors and owners only (the same level as the /verify screen).
    await actorFor('editor')
    const db = dbOrNull()
    const [providers, counts] = await Promise.all([providerBalancesAsync(), db ? verificationCounts(db) : Promise.resolve(null)])
    return NextResponse.json({ providers, pricing: getPricing(), counts }, { headers: NO_STORE })
  } catch (e) {
    return fail(e)
  }
}
