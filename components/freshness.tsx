import { formatDate, isUnavailable } from '@/lib/format'
import { Figure, Unavailable } from '@/components/primitives'
import { COPY } from '@/lib/copy'

/**
 * What we can honestly claim about the snapshot.
 *
 * Three states, not two. `stale` alone could not express "the source reported
 * no collection time and no failure either", so the component fell back to
 * claiming `Collected` followed by a dash and `data-stale="false"`. That is the
 * worst combination available: it asserts the data is current while admitting
 * it does not know when it was gathered. Absence of a timestamp is not evidence
 * of freshness, so it gets its own state rather than being rounded down to
 * "not stale".
 */
type FreshnessState = 'fresh' | 'failed' | 'unknown'

function freshnessState(generatedAt: string | null, collectionFailed: boolean): FreshnessState {
  if (collectionFailed) return 'failed'
  return isUnavailable(generatedAt) ? 'unknown' : 'fresh'
}

/**
 * Data freshness.
 *
 * The single most load-bearing line on the dashboard: it tells Jacob whether
 * he is looking at numbers collected now or numbers collected three days ago.
 * Presenting stale data as fresh is a lie, so this is a bare, explicit line --
 * not a badge, not a coloured pill, not a "LIVE" indicator we cannot back up.
 *
 * `generatedAt` is the timestamp the source reported. `stale` is the caller's
 * judgement that the collection is overdue. Neither is invented here: a missing
 * timestamp renders as a dash, not as "just now".
 */
export function FreshnessIndicator({
  generatedAt,
  stale,
}: {
  generatedAt: string | null
  stale: boolean
}) {
  const state = freshnessState(generatedAt, stale)
  const hasTime = !isUnavailable(generatedAt)

  return (
    <div
      data-testid="freshness"
      data-stale={stale ? 'true' : 'false'}
      data-freshness={state}
      className="flex items-baseline gap-2 text-[11px] text-ink-faint"
    >
      <span className="text-ink-muted">
        {state === 'failed'
          ? COPY.staleDataFailed
          : state === 'unknown'
            ? COPY.freshnessUnknown
            : COPY.staleDataOk('').trim()}
      </span>
      <span data-testid="freshness-time" className="font-numeric tabular-nums">
        {hasTime ? formatDate(generatedAt) : <Unavailable />}
      </span>
    </div>
  )
}
