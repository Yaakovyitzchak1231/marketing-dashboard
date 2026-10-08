import Link from 'next/link'
import { getDb } from '@/lib/db'
import { DbNotConnected, BUTTON_PRIMARY } from '@/components/app/PageShell'
import { Card, EmptyNote, SectionHeader } from '@/components/dashboard/primitives'
import { CheckPill, Flash, one, when } from '@/components/seo/bits'
import { auditHistory, getAudit, listSites, type AuditRow, type SiteRow } from '@/lib/seo/store'
import type { Check } from '@/lib/seo/audit'
import { runAuditAction } from '@/app/actions/seo'

export const dynamic = 'force-dynamic'
type SP = Record<string, string | string[] | undefined>

const ORDER: Record<string, number> = { fail: 0, warn: 1, unknown: 2, pass: 3 }

export default async function SeoAudit({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams
  const db = getDb()
  if (!db) return <DbNotConnected what="The SEO section" />
  let sites: SiteRow[] = []
  let history: AuditRow[] = []
  let audit: AuditRow | null = null
  try {
    sites = await listSites(db)
    const siteId = Number(one(sp.site)) || sites.find((s) => s.active)?.id || null
    history = siteId ? await auditHistory(db, siteId, 12) : []
    const aid = Number(one(sp.audit))
    audit = aid ? await getAudit(db, aid) : (history.find((h) => h.status === 'done') ?? null)
  } catch {
    return <EmptyNote>Couldn&rsquo;t read the SEO tables. Run the database migrations.</EmptyNote>
  }
  const site = sites.find((s) => s.id === (audit?.site_id ?? (Number(one(sp.site)) || sites.find((x) => x.active)?.id)))
  const groups = new Map<string, Check[]>()
  for (const c of audit?.checks ?? []) {
    const k = c.page ?? 'Whole site'
    groups.set(k, [...(groups.get(k) ?? []), c])
  }

  return (
    <div className="space-y-6">
      <Flash sp={sp} />
      <div className="flex flex-wrap items-center gap-2">
        {sites.map((s) => (
          <Link
            key={s.id}
            href={`/seo/audit?site=${s.id}`}
            className={`rounded-card border px-2.5 py-1 text-[12px] ${s.id === site?.id ? 'border-accent text-accent' : 'border-line text-ink-muted hover:text-ink'}`}
          >
            {s.name}
          </Link>
        ))}
        {site ? (
          <form action={runAuditAction} className="ml-auto">
            <input type="hidden" name="site_id" value={site.id} />
            <input type="hidden" name="return_to" value="/seo/audit" />
            <button className={BUTTON_PRIMARY}>Re-run audit</button>
          </form>
        ) : null}
      </div>

      {!audit ? (
        <EmptyNote>{site ? `${site.name} hasn't been audited yet. Press "Re-run audit".` : 'Add a site first.'}</EmptyNote>
      ) : (
        <>
          <p className="text-[12px] text-ink-faint">
            Audit #{audit.id} of {site?.base_url.replace(/^https?:\/\//, '')} · {when(audit.finished_at ?? audit.started_at)} · fetched from the {audit.fetched_from ?? 'dashboard server'} ·{' '}
            {audit.status === 'done' ? `${audit.passed} pass, ${audit.failed} fix, ${audit.warned} improve, ${audit.unknown} couldn't check` : audit.status}
            {audit.error ? ` · ${audit.error}` : ''}
          </p>
          {[...groups.entries()].map(([page, checks]) => (
            <section key={page}>
              <SectionHeader title={page} />
              <Card>
                <ul className="divide-y divide-line">
                  {[...checks].sort((a, b) => ORDER[a.status] - ORDER[b.status]).map((c, i) => (
                    <li key={i} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[110px_200px_1fr] sm:gap-3" data-testid="seo-check">
                      <div>
                        <CheckPill status={c.status} />
                      </div>
                      <p className="text-[13px] font-medium text-ink">{c.label}</p>
                      <div className="text-[13px] leading-snug text-ink-muted">
                        <p className="break-words">{c.detail}</p>
                        {c.fix && c.status !== 'pass' ? <p className="mt-1 text-[12px] text-ink">Fix: {c.fix}</p> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          ))}
          <p className="text-[12px] text-ink-faint">
            Every non-passing check is on the <Link href={`/seo/todos?site=${audit.site_id}`} className="text-accent underline">fix list</Link> with a button to act on it.
          </p>
        </>
      )}

      {history.length ? (
        <section>
          <SectionHeader title="History" />
          <Card>
            <table className="w-full text-[12px]">
              <thead className="text-left text-ink-faint">
                <tr>
                  <th className="px-4 py-2 font-medium">Run</th>
                  <th className="px-2 py-2 font-medium">When</th>
                  <th className="px-2 py-2 text-right font-medium">Pass</th>
                  <th className="px-2 py-2 text-right font-medium">Fix</th>
                  <th className="px-2 py-2 text-right font-medium">Improve</th>
                  <th className="px-4 py-2 text-right font-medium">Couldn&rsquo;t check</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line font-numeric">
                {history.map((h) => (
                  <tr key={h.id}>
                    <td className="px-4 py-1.5">
                      <Link href={`/seo/audit?site=${h.site_id}&audit=${h.id}`} className="text-accent underline">#{h.id}</Link>
                      {h.status !== 'done' ? <span className="ml-1 text-ink-faint">{h.status}</span> : null}
                    </td>
                    <td className="px-2 py-1.5 text-ink-muted">{when(h.finished_at ?? h.started_at)}</td>
                    <td className="px-2 py-1.5 text-right">{h.passed ?? '—'}</td>
                    <td className="px-2 py-1.5 text-right">{h.failed ?? '—'}</td>
                    <td className="px-2 py-1.5 text-right">{h.warned ?? '—'}</td>
                    <td className="px-4 py-1.5 text-right">{h.unknown ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      ) : null}
    </div>
  )
}
