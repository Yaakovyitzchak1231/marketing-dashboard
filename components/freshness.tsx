import { formatDate, isUnavailable } from '@/lib/format'
import { Figure, Unavailable } from '@/components/primitives'
import { COPY } from '@/lib/copy'

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
  return (
    <div
      data-testid="freshness"
      data-stale={stale ? 'true' : 'false'}
      className="flex items-baseline gap-2 text-[11px] text-ink-faint"
    >
      <span className="text-ink-muted">
        {stale ? COPY.staleDataFailed : COPY.staleDataOk('').trim()}
      </span>
      {!stale && !isUnavailable(generatedAt) ? (
        <span data-testid="freshness-time" className="font-numeric tabular-nums">
          {formatDate(generatedAt)}
        </span>
      ) : null}
      {/* A missing timestamp has no date to show, but it must still occupy the
          slot so the line does not silently shrink into "fresh-looking". */}
      {isUnavailable(generatedAt) ? (
        <span data-testid="freshness-time">
          <Unavailable />
        </span>
      ) : null}
    </div>
  )
}
