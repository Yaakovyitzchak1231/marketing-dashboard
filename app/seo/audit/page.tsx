import Link from 'next/link'
import { getDb } from '@/lib/db'
import { DbNotConnected, BUTTON_PRIMARY } from '@/components/app/PageShell'
import { Card, EmptyNote, SectionHeader } from '@/components/dashboard/primitives'
import { CheckPill, Flash, one, when } from '@/components/seo/bits'
import { auditHistory, getAudit, listSites, type AuditRow, type SiteRow } from '@/lib/seo/store'
import type { Check, CheckStatus } from '@/lib/seo/audit'
import { runAuditAction } from '@/app/actions/seo'

export const dynamic = 'force-dynamic'
type SP = Record<string, string | string[] | undefined>

const ORDER: Record<CheckStatus, number> = { fail: 0, warn: 1, blocked: 2, unknown: 3, pass: 4, info: 5 }

/** The detail with its leading reason ("Blocked: SiteGround captcha (HTTP 202)") in bold. */
function Detail({ c }: { c: Check }) {
  if (c.reason && c.detail.startsWith(c.reason)) {
    return (
      <p className="break-words">
        <span className="font-medium text-ink">{c.reason}</span>
        {c.detail.slice(c.reason.length)}
      </p>
    )
  }
  return <p className="break-words">{c.detail}</p>
}

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
  const blockedN = (audit?.checks ?? []).filter((c) => c.status === 'blocked').length
  // Stored `unknown` counts blocked checks too (no schema change); split them for display.
  const unreadN = audit?.unknown == null ? null : Math.max(0, audit.unknown - blockedN)
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
            className={`rounded-card border px-2.5 py-1 text-xs ${s.id === site?.id ? 'border-accent text-accent' : 'border-line text-ink-muted hover:text-ink'}`}
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
          <p className="text-xs text-ink-faint">
            Audit #{audit.id} of {site?.base_url.replace(/^https?:\/\//, '')} · {when(audit.finished_at ?? audit.started_at)} · fetched from the {audit.fetched_from ?? 'dashboard server'} ·{' '}
            {audit.status === 'done' ? `${audit.passed} pass, ${audit.failed} fix, ${audit.warned} improve${blockedN ? `, ${blockedN} blocked` : ''}, ${unreadN ?? '—'} couldn't check` : audit.status}
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
                        <CheckPill status={c.status} reason={c.reason} />
                      </div>
                      <p className="text-sm font-medium text-ink">{c.label}</p>
                      <div className="text-sm leading-snug text-ink-muted">
                        <Detail c={c} />
                        {c.fix && c.status !== 'pass' ? <p className="mt-1 text-xs text-ink">{c.status === 'info' ? 'Note' : 'Review'}: {c.fix}</p> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          ))}
          <p className="text-xs text-ink-faint">
            Actionable findings appear on the <Link href={`/seo/todos?site=${audit.site_id}`} className="text-accent underline">fix list</Link>. Informational checks are not required fixes and are excluded from the pass/fix counts. Blocked means the site kept our checker out, with the reason shown; it is not counted as a fix.
          </p>
        </>
      )}

      {history.length ? (
        <section>
          <SectionHeader title="History" />
          <Card>
            <table className="w-full text-xs">
              <thead className="text-left text-ink-faint">
                <tr>
                  <th className="px-4 py-2 font-medium">Run</th>
                  <th className="px-2 py-2 font-medium">When</th>
                  <th className="px-2 py-2 text-right font-medium">Pass</th>
                  <th className="px-2 py-2 text-right font-medium">Fix</th>
                  <th className="px-2 py-2 text-right font-medium">Improve</th>
                  <th className="px-4 py-2 text-right font-medium">Blocked / couldn&rsquo;t check</th>
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
