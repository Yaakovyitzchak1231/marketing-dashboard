import Link from 'next/link'
import { PageShell, BUTTON } from '@/components/app/PageShell'
import { Card, SectionHeader } from '@/components/dashboard/primitives'
import { ActionNote } from '@/components/reports/Note'
import { LevelPill, SampleBanner } from '@/components/reports/bits'
import { ConfirmAction } from '@/components/reports/ConfirmAction'
import { runSheetExportAction } from '@/app/actions/reports'
import { currentRole } from '@/lib/auth/session'
import { canAtLeast } from '@/lib/auth/roles'
import { loadReportInputs, rangeDays } from '@/lib/reports/load'
import { campaignRunway, formatDays, segmentRunway } from '@/lib/reports/runway'
import { SEGMENT_LABEL } from '@/lib/reports/meta'
import { liveExportCounts, recentExports, type ExportRun } from '@/lib/export/lead-master'
import { DEFAULT_EXPORT_TAB, sheetExportConfigured } from '@/lib/export/sheets'

export const dynamic = 'force-dynamic'

const CARDS = [
  { href: '/reports/weekly', title: 'Weekly one-pager', body: 'Sends, replies, interested, meetings, bounces, best and worst angle, runway and open items. Prints to PDF.' },
  { href: '/reports/runway', title: 'Lead runway', body: 'Leads left per segment and campaign, and how many days they last at the current pace.' },
  { href: '/reports/costs', title: 'Cost per meeting', body: 'Reply rate, interested, meetings and cost per meeting by angle and campaign, from your monthly cost table.' },
]

export default async function ReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const inp = await loadReportInputs('7d')
  const cr = inp.data.campaigns.map((c) => campaignRunway(c, inp.meta.get(c.id), rangeDays(inp.data)))
  const low = [
    ...(inp.pools ? segmentRunway(inp.pools, cr) : []).filter((s) => s.level === 'low' || s.level === 'out').map((s) => ({ key: s.segment, name: `${SEGMENT_LABEL[s.segment]} (all leads)`, days: s.days, level: s.level })),
    ...cr.filter((c) => c.level === 'low' || c.level === 'out').map((c) => ({ key: c.id, name: c.name, days: c.days, level: c.level })),
  ]
  let exportsList: ExportRun[] = []
  let liveCounts: { emails: number; leads: number; leadsWithoutEmail: number } | null = null
  if (inp.db && !inp.dbError) {
    ;[exportsList, liveCounts] = await Promise.all([recentExports(inp.db).catch(() => []), liveExportCounts(inp.db).catch(() => null)])
  }
  const sheetReady = sheetExportConfigured()
  // Both exports need editor access (the route and the action refuse a viewer), so a viewer gets a plain line, not a dead link.
  const canExport = canAtLeast(await currentRole(), 'editor')

  return (
    <PageShell title="Reports" meta="The numbers that decide what to do next, each with the button to do it.">
      {inp.sample ? <SampleBanner /> : null}
      <ActionNote note={sp.note} tone={sp.tone} />
      {low.length ? (
        <Card className="mb-5 border-warn/30 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-[0.06em] text-warn">Running low on leads</p>
          <ul className="mt-1.5 space-y-1 text-sm">
            {low.map((l) => (
              <li key={l.key} className="flex items-center justify-between gap-2">
                <span>{l.name}</span>
                <span className="flex items-center gap-2 font-numeric tabular-nums">{formatDays(l.days)} <LevelPill level={l.level} /></span>
              </li>
            ))}
          </ul>
          <Link href="/reports/runway" prefetch={false} className={`${BUTTON} mt-2`}>Open runway</Link>
        </Card>
      ) : null}

      <div className="mb-8 grid gap-3 sm:grid-cols-3">
        {CARDS.map((c) => (
          <Link key={c.href} href={c.href} prefetch={false} className="block">
            <Card className="h-full px-4 py-4 hover:border-ink-faint">
              <h2 className="text-sm font-semibold text-ink">{c.title}</h2>
              <p className="mt-1 text-xs leading-snug text-ink-muted">{c.body}</p>
            </Card>
          </Link>
        ))}
      </div>

      <section aria-labelledby="lm-h">
        <SectionHeader id="lm-h" title="Lead Master copy (read-only)" meta="The lead database written back out. The Lead Master Leads tab is never changed." />
        <Card className="px-4 py-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            {!canExport ? (
              <p className="text-sm text-ink-muted">CSV export needs editor access.</p>
            ) : inp.db ? (
              <a href="/api/reports/lead-master" className={BUTTON}>Download CSV</a>
            ) : (
              <span className={`${BUTTON} cursor-not-allowed opacity-50`}>Download CSV</span>
            )}
            <ConfirmAction
              action={runSheetExportAction}
              fields={{}}
              label={`Write to “${DEFAULT_EXPORT_TAB}” tab`}
              confirmText={`Overwrite the “${DEFAULT_EXPORT_TAB}” tab of the Lead Master Sheet with the database copy? No other tab is touched.`}
              confirmLabel="Write the copy"
              disabled={!canExport || !inp.db || !sheetReady}
              disabledReason={canExport ? 'Needs DATABASE_URL, LEAD_MASTER_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON' : 'Needs editor access'}
            />
          </div>
          {!sheetReady ? (
            <p className="mt-2 text-xs text-ink-faint">
              To write the Sheet tab, set LEAD_MASTER_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON (share the Sheet with that service account as Editor). The CSV works without them.
            </p>
          ) : null}
          {liveCounts ? (
            <p className="mt-3 text-xs text-ink-muted" data-testid="export-live-counts">
              A copy written now: {liveCounts.leads.toLocaleString('en-US')} leads with an email, {liveCounts.emails.toLocaleString('en-US')} rows (one row per email address).
              {liveCounts.leadsWithoutEmail
                ? ` ${liveCounts.leadsWithoutEmail.toLocaleString('en-US')} more ${liveCounts.leadsWithoutEmail === 1 ? 'lead has' : 'leads have'} no email yet, so ${liveCounts.leadsWithoutEmail === 1 ? 'it is' : 'they are'} counted on Overview but not in the copy.`
                : ''}
            </p>
          ) : null}
          {exportsList.length ? (
            <ul className="mt-3 space-y-1 text-xs text-ink-muted">
              {exportsList.map((e) => (
                <li key={e.id}>
                  {new Date(e.started_at).toLocaleString('en-US', { timeZone: inp.data.range.timezone, dateStyle: 'medium', timeStyle: 'short' })}:{' '}
                  {e.target === 'sheet' ? 'Sheet tab' : 'CSV'} · {e.status}
                  {e.row_count !== null ? ` · ${e.row_count.toLocaleString('en-US')} email rows as of that day` : ''}
                  {e.error ? ` · ${e.error}` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-ink-faint">No copies written yet.</p>
          )}
        </Card>
      </section>
    </PageShell>
  )
}
