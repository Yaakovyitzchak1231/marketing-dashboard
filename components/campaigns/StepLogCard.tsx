import { Card, EmptyNote, Pill, SectionHeader } from '@/components/dashboard/primitives'
import type { StepLogRow } from '@/lib/actions/execute'

const tone = (s: StepLogRow['status']) => (s === 'ok' ? 'good' : s === 'failed' ? 'bad' : 'neutral')

/** Recent action-library executions for a campaign (server-rendered). */
export function StepLogCard({ entries }: { entries: StepLogRow[] }) {
  return (
    <section aria-labelledby="steplog-h">
      <SectionHeader id="steplog-h" title="Step log" meta="Every action the action library ran for this journey" />
      <Card>
        {!entries.length ? (
          <EmptyNote>No actions run yet. Journey steps log here automatically; agents can run actions via the run_action op.</EmptyNote>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-ink-muted">
                <th className="py-1 pr-2">When</th>
                <th className="py-1 pr-2">Step</th>
                <th className="py-1 pr-2">Action</th>
                <th className="py-1 pr-2">Lead</th>
                <th className="py-1 pr-2">Status</th>
                <th className="py-1 pr-2">Detail</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-t border-line-soft">
                  <td className="py-1 pr-2 whitespace-nowrap text-ink-muted">
                    {new Date(e.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  </td>
                  <td className="py-1 pr-2 font-mono">{e.step_key}</td>
                  <td className="py-1 pr-2 font-mono">{e.action}</td>
                  <td className="py-1 pr-2">{e.company_id ? `#${e.company_id}` : '—'}</td>
                  <td className="py-1 pr-2"><Pill tone={tone(e.status)}>{e.status}</Pill></td>
                  <td className="py-1 pr-2 text-ink-muted">
                    {e.status === 'failed' ? e.error : e.actor ? `by ${e.actor}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </section>
  )
}
