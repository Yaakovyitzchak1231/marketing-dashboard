import { Card, EmptyNote, Pill, SectionHeader } from '@/components/dashboard/primitives'
import { agoWords } from '@/lib/jobs/runner-status'
import type { SourceHealth } from '@/lib/sources/health'

const DASH = '—'

function typesLine(byType: Record<string, number> | null): string {
  if (!byType || !Object.keys(byType).length) return DASH
  return Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k.replace(/_/g, ' ')} ${n}`)
    .join(', ')
}

function statusPill(s: SourceHealth) {
  if (s.last_event_at === null && s.error_count_24h === null) return <Pill tone="neutral">No data yet</Pill>
  if (s.error_count_24h) return <Pill tone="bad">{s.error_count_24h} error{s.error_count_24h === 1 ? '' : 's'} (24h)</Pill>
  if (s.last_event_at === null) return <Pill tone="neutral">No data yet</Pill>
  return <Pill tone="good">OK</Pill>
}

/** Plan 1.11: one honest row per data source feeding the lead platform. Every
 * number comes from a stored row (lib/sources/health.ts); null renders as
 * "No data yet", never an invented zero. */
export function DataSourcesSection({ sources }: { sources: SourceHealth[] }) {
  return (
    <section className="mb-6" aria-labelledby="data-sources-heading">
      <SectionHeader
        id="data-sources-heading"
        title="Data sources"
        meta="Where the lead platform's data comes from, and whether it's still arriving"
      />
      <Card>
        {sources.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-[0.04em] text-ink-faint">
                  <th className="px-3 py-2 font-medium">Source</th>
                  <th className="px-3 py-2 font-medium">Last event</th>
                  <th className="px-3 py-2 font-medium">24h volume</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Last error</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.id} className="border-b border-line/60 last:border-0">
                    <td className="px-3 py-2 text-ink">{s.label}</td>
                    <td className="px-3 py-2 text-ink-muted">{s.last_event_at ? agoWords(s.last_event_at) : DASH}</td>
                    <td className="px-3 py-2 text-ink-muted">{s.count_24h === null ? DASH : `${s.count_24h} (${typesLine(s.by_type_24h)})`}</td>
                    <td className="px-3 py-2">{statusPill(s)}</td>
                    <td className="px-3 py-2 text-ink-faint">{s.last_error ? `${s.last_error}${s.last_error_at ? ` (${agoWords(s.last_error_at)})` : ''}` : DASH}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyNote>No sources to show yet.</EmptyNote>
        )}
      </Card>
    </section>
  )
}
