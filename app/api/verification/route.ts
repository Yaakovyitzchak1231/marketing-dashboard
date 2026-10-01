import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'

/**
 * Verification summary: which lead source/list produces the cleanest
 * verified addresses.
 *
 * Groups leads by source_detail (the Instantly campaign the lead came
 * from) and reports the ZeroBounce/MillionVerifier status mix. "Clean"
 * = valid / verified. Role-skipped addresses are reported separately --
 * they were never sent to a verifier.
 */

const CLEAN = new Set(['valid', 'ok'])
const DIRTY = new Set(['invalid', 'spamtrap', 'abuse'])

export async function GET(request: NextRequest) {
  const supabase = await getRequestClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  }

  // Pull in pages; the table can be large.
  const all: Record<string, unknown>[] = []
  let from = 0
  const page = 1000
  for (;;) {
    const { data, error } = await supabase
      .from('leads')
      .select('source, source_detail, zb_status, zb_substatus, mv_result')
      .range(from, from + page - 1)
    if (error) {
      return NextResponse.json({ error: 'Failed to fetch leads' }, { status: 500 })
    }
    if (!data || data.length === 0) break
    all.push(...(data as Record<string, unknown>[]))
    if (data.length < page) break
    from += page
    if (from > 50000) break // sanity cap
  }

  type Bucket = {
    total: number; verified: number; clean: number; dirty: number;
    catch_all: number; role_skipped: number; unverified: number;
  }
  const bySource = new Map<string, Bucket>()
  const bucket = (key: string): Bucket => {
    let b = bySource.get(key)
    if (!b) {
      b = { total: 0, verified: 0, clean: 0, dirty: 0, catch_all: 0, role_skipped: 0, unverified: 0 }
      bySource.set(key, b)
    }
    return b
  }

  for (const l of all) {
    const key = (l.source_detail as string) || (l.source as string) || 'unknown'
    const b = bucket(key)
    b.total += 1
    const zb = (l.zb_status as string | null)?.toLowerCase() ?? null
    const mv = (l.mv_result as string | null)?.toLowerCase() ?? null
    const status = zb ?? mv
    if (!status) { b.unverified += 1; continue }
    b.verified += 1
    if (zb === 'do_not_mail' && (l.zb_substatus as string) === 'role_address') {
      b.role_skipped += 1
    } else if (status === 'catch-all' || status === 'catch_all' || status === 'catchall') {
      b.catch_all += 1
    } else if (CLEAN.has(status)) {
      b.clean += 1
    } else if (DIRTY.has(status) || status === 'do_not_mail') {
      b.dirty += 1
    } else {
      b.catch_all += 1 // unknown / other: neither clean nor dirty
    }
  }

  const sources = [...bySource.entries()].map(([source, b]) => ({
    source,
    ...b,
    clean_rate: b.verified > 0 ? Math.round((b.clean / b.verified) * 10000) / 10000 : null,
  }))
  sources.sort((a, b) => (b.clean_rate ?? -1) - (a.clean_rate ?? -1))

  const { data: runs } = await supabase
    .from('verification_runs')
    .select('provider, list_name, ran_at, total, valid, invalid, credits_used')
    .order('ran_at', { ascending: false })
    .limit(10)

  return NextResponse.json({ sources, recent_runs: runs ?? [] })
}
