import type { AccountHealth, SenderAccount } from '@/lib/dashboard/types'
import { formatCount, formatPct } from './format'
import { Card, EmptyNote, Pill, SectionHeader, Val, type PillTone } from './primitives'

const HEALTH: Record<AccountHealth, { label: string; tone: PillTone; rank: number }> = {
  at_risk: { label: 'At risk', tone: 'bad', rank: 0 },
  watch: { label: 'Watch', tone: 'warn', rank: 1 },
  unknown: { label: 'Unknown', tone: 'neutral', rank: 2 },
  healthy: { label: 'Healthy', tone: 'good', rank: 3 },
}

export function sortAccounts(accounts: SenderAccount[]): SenderAccount[] {
  return [...accounts].sort(
    (a, b) =>
      (HEALTH[a.health]?.rank ?? 9) - (HEALTH[b.health]?.rank ?? 9) ||
      (b.bounceRate ?? -1) - (a.bounceRate ?? -1) ||
      a.email.localeCompare(b.email),
  )
}

function Health({ a }: { a: SenderAccount }) {
  const h = HEALTH[a.health] ?? HEALTH.unknown
  return <Pill tone={h.tone} title={`${a.healthReason} · Instantly status: ${a.status}`}>{h.label}</Pill>
}

/** Instantly's own status word, shown only when it is not the normal "active". */
function StatusNote({ status }: { status: string }) {
  if (!status || status.toLowerCase() === 'active') return null
  return <div className="mt-0.5 text-xs text-ink-muted">Instantly status: <span className="font-medium">{status}</span></div>
}

/** The campaigns an inbox sends for, in one quiet line. */
function CampaignNote({ a }: { a: SenderAccount }) {
  if (!a.campaigns) return null
  if (a.campaigns.length === 0) return <div className="mt-0.5 text-xs text-ink-faint">On no campaign</div>
  const names = a.campaigns.map((c) => (c.status === 'active' ? c.name : `${c.name} (${c.status})`))
  return <div className="mt-0.5 truncate text-xs text-ink-faint" title={names.join(', ')}>On: {names.join(', ')}</div>
}

function AccountList({ rows }: { rows: SenderAccount[] }) {
  return (
    <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm" data-testid="accounts-table">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-faint">
                    <th className="py-2.5 pl-4 pr-2 font-medium">Inbox</th>
                    <th className="px-2 py-2.5 font-medium">Health</th>
                    <th className="px-2 py-2.5 text-right font-medium" title="Instantly warmup score, 0–100">Warmup</th>
                    <th className="px-2 py-2.5 text-right font-medium">Sent</th>
                    <th className="px-2 py-2.5 text-right font-medium" title="Bounced ÷ sent from this inbox">Bounce</th>
                    <th className="py-2.5 pl-2 pr-4 text-right font-medium" title="Daily sending limit set in Instantly">Limit</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {rows.map((a) => (
                    <tr key={a.email} className="align-top hover:bg-canvas/60">
                      <td className="max-w-[260px] py-2.5 pl-4 pr-2">
                        <div className="truncate font-medium text-ink" title={a.email}>{a.email}</div>
                        <div className="mt-0.5 text-xs leading-snug text-ink-faint">{a.healthReason}</div>
                        <StatusNote status={a.status} />
                        <CampaignNote a={a} />
                      </td>
                      <td className="px-2 py-2.5"><Health a={a} /></td>
                      <td className="px-2 py-2.5 text-right font-numeric"><Val value={a.warmupScore}>{formatCount(a.warmupScore)}</Val></td>
                      <td className="px-2 py-2.5 text-right font-numeric"><Val value={a.sent}>{formatCount(a.sent)}</Val></td>
                      <td className="px-2 py-2.5 text-right font-numeric"><Val value={a.bounceRate}>{formatPct(a.bounceRate)}</Val></td>
                      <td className="py-2.5 pl-2 pr-4 text-right font-numeric"><Val value={a.dailyLimit}>{formatCount(a.dailyLimit)}</Val></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-line-soft md:hidden">
              {rows.map((a) => (
                <li key={a.email} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="break-all text-sm font-medium text-ink">{a.email}</div>
                      <div className="mt-0.5 text-xs leading-snug text-ink-faint">{a.healthReason}</div>
                      <StatusNote status={a.status} />
                        <CampaignNote a={a} />
                    </div>
                    <Health a={a} />
                  </div>
                  <dl className="mt-2 grid grid-cols-4 gap-2 text-xs">
                    <div><dt className="text-ink-faint">Warmup</dt><dd className="font-numeric text-ink"><Val value={a.warmupScore}>{formatCount(a.warmupScore)}</Val></dd></div>
                    <div><dt className="text-ink-faint">Sent</dt><dd className="font-numeric text-ink"><Val value={a.sent}>{formatCount(a.sent)}</Val></dd></div>
                    <div><dt className="text-ink-faint">Bounce</dt><dd className="font-numeric text-ink"><Val value={a.bounceRate}>{formatPct(a.bounceRate)}</Val></dd></div>
                    <div><dt className="text-ink-faint">Limit</dt><dd className="font-numeric text-ink"><Val value={a.dailyLimit}>{formatCount(a.dailyLimit)}</Val></dd></div>
                  </dl>
                </li>
              ))}
            </ul>
    </>
  )
}

export function AccountsTable({ accounts }: { accounts: SenderAccount[] }) {
  // Inboxes on an active campaign (or unknown) first; inboxes no active campaign uses fold away.
  const current = sortAccounts(accounts.filter((a) => a.inActiveCampaign !== false))
  const unused = sortAccounts(accounts.filter((a) => a.inActiveCampaign === false))
  const unusedErrors = unused.filter((a) => a.health === 'at_risk').length
  const flagged = current.filter((a) => a.health === 'at_risk' || a.health === 'watch').length
  const meta = accounts.length
    ? `${current.length} on active campaigns${flagged ? ` · ${flagged} flagged` : ' · all clear'}${unused.length ? ` · ${unused.length} unused` : ''}`
    : undefined
  return (
    <section className="min-w-0" aria-labelledby="accounts-heading">
      <SectionHeader id="accounts-heading" title="Sending accounts" meta={meta} />
      <Card>
        {accounts.length === 0 ? (
          <EmptyNote>No sending accounts reported.</EmptyNote>
        ) : (
          <>
            {current.length ? <AccountList rows={current} /> : <EmptyNote>No inbox is attached to an active campaign.</EmptyNote>}
            {unused.length ? (
              <details className="border-t border-line" data-testid="unused-accounts">
                <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-ink-muted hover:text-ink">
                  Show {unused.length} inbox{unused.length === 1 ? '' : 'es'} not on any active campaign
                  {unusedErrors ? ` (${unusedErrors} with errors)` : ''}
                </summary>
                <AccountList rows={unused} />
              </details>
            ) : null}
          </>
        )}
      </Card>
    </section>
  )
}
