import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { groupStages, labelForStage } from '@/lib/stages'

/**
 * Collection error feed for the partial-data banner.
 *
 * Reads `collection_errors` -- the collector's own record of failed calls.
 * Every count here is the collector's count. Nothing is inferred, and an empty
 * database is reported as `errors: []` with `partial: false` rather than being
 * read as "everything is fine" when in fact nothing has run yet.
 *
 * `partial` is derived from whether any *unresolved* error exists. A resolved
 * error means the collector has since succeeded, and re-showing the banner for
 * it would be reporting a stale failure.
 *
 * @build-copy renders from `stages[]` labels; it never renders a raw stage key.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  // Bound the lookback so an old, long-resolved failure cannot reappear.
  const hours = Math.min(Math.max(Number(searchParams.get('hours')) || 24, 1), 24 * 30)
  const since = new Date(Date.now() - hours * 3600_000).toISOString()

  try {
    const { data, error } = await supabase
      .from('collection_errors')
      .select('collected_at, run_started_at, stage, campaign_external_id, error, resolved')
      .gte('collected_at', since)
      .order('collected_at', { ascending: false })
      .limit(200)

    if (error) throw error

    const rows = data || []
    const unresolved = rows.filter((r) => !r.resolved)

    const lastAttempt = rows.length > 0 ? rows[0].collected_at : null

    return NextResponse.json({
      // The count of distinct stages, not the count of rows: one failed stage
      // that hit three campaigns is one sentence, not three.
      stages: groupStages(unresolved.map((r) => ({ stage: r.stage }))),
      unresolved_count: unresolved.length,
      total_in_window: rows.length,
      partial: unresolved.length > 0,
      last_attempt: lastAttempt,
      run_started_at: rows.length > 0 ? rows[0].run_started_at : null,
      hours,
    })
  } catch (error) {
    console.error('Collection errors API error:', error)
    // A failure to read the error feed is itself a partial state. Report it as
    // unknown rather than as "no errors".
    return NextResponse.json(
      {
        error: 'Failed to fetch collection errors',
        stages: [],
        unresolved_count: null,
        partial: true,
        last_attempt: null,
      },
      { status: 500 }
    )
  }
}

export { labelForStage }
