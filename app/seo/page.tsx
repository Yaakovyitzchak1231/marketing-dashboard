import Link from 'next/link'
import { getDb } from '@/lib/db'
import { DbNotConnected, BUTTON, BUTTON_PRIMARY } from '@/components/app/PageShell'
import { Card, EmptyNote, Pill, SectionHeader } from '@/components/dashboard/primitives'
import { CheckPill, Flash, when } from '@/components/seo/bits'
import { latestAudits, latestRuns, listFixTasks, listSites, type AuditRow, type FixTask, type SiteRow, type VisRun } from '@/lib/seo/store'
import { PROVIDERS, providerKey } from '@/lib/seo/visibility'
import { runAuditAction } from '@/app/actions/seo'

export const dynamic = 'force-dynamic'
type SP = Record<string, string | string[] | undefined>

export default async function SeoOverview({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams
  const db = getDb()
  if (!db) return <DbNotConnected what="The SEO section" />
  let sites: SiteRow[] = []
  let audits = new Map<number, AuditRow>()
  let runs: VisRun[] = []
  let fixes: FixTask[] = []
  let failed = false
  try {
    ;[sites, audits, runs, fixes] = await Promise.all([listSites(db, { activeOnly: true }), latestAudits(db), latestRuns(db), listFixTasks(db, { open: true })])
  } catch {
    failed = true
  }
  if (failed) return <EmptyNote>Couldn&rsquo;t read the SEO tables. Run the database migrations (db/migrations/0004_seo.sql).</EmptyNote>

  return (
    <div className="space-y-7">
      <Flash sp={sp} />
      <section>
        <SectionHeader
          title="Sites"
          meta={
            <form action={runAuditAction}>
              <input type="hidden" name="return_to" value="/seo" />
              <button className={BUTTON}>Re-run all audits</button>
            </form>
          }
        />
        {sites.length === 0 ? (
          <EmptyNote>
            No sites yet. <Link className="text-accent underline" href="/seo/sites">Add one</Link>.
          </EmptyNote>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {sites.map((s) => {
              const a = audits.get(s.id)
              const top = a?.checks.filter((c) => c.status === 'fail').slice(0, 3) ?? []
              const open = fixes.filter((f) => f.payload.site_id === s.id).length
              return (
                <Card key={s.id} className="px-4 py-4">
                  <div data-testid="seo-site-card">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate text-[14px] font-semibold text-ink">{s.name}</h3>
                        <p className="truncate text-[12px] text-ink-faint">
                          {s.base_url.replace(/^https?:\/\//, '')} · {[s.platform, s.host].filter(Boolean).join(' on ') || 'platform not set'}
                        </p>
                      </div>
                      <form action={runAuditAction} className="shrink-0">
                        <input type="hidden" name="site_id" value={s.id} />
                        <input type="hidden" name="return_to" value="/seo" />
                        <button className={BUTTON_PRIMARY}>{a ? 'Re-run audit' : 'Run audit'}</button>
                      </form>
                    </div>
                    {a ? (
                      <>
                        <dl className="mt-3 grid grid-cols-4 gap-2 text-center">
                          {(
                            [
                              ['Pass', a.passed, 'text-good'],
                              ['Fix', a.failed, 'text-bad'],
                              ['Improve', a.warned, 'text-warn'],
                              ["Couldn't check", a.unknown, 'text-ink-muted'],
                            ] as const
                          ).map(([label, v, cls]) => (
                            <div key={label} className="rounded-card border border-line bg-canvas px-1 py-2">
                              <dd className={`font-numeric text-[18px] font-semibold ${cls}`}>{v ?? '—'}</dd>
                              <dt className="text-[11px] text-ink-faint">{label}</dt>
                            </div>
                          ))}
                        </dl>
                        {top.length ? (
                          <ul className="mt-3 space-y-1.5">
                            {top.map((c, i) => (
                              <li key={i} className="flex gap-2 text-[12px] leading-snug text-ink">
                                <CheckPill status={c.status} />
                                <span>
                                  {c.label}
                                  {c.page ? <span className="text-ink-faint"> · {c.page}</span> : null}
                                </span>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        <p className="mt-3 text-[12px] text-ink-faint">
                          Audited {when(a.finished_at)} ·{' '}
                          <Link className="text-accent underline" href={`/seo/audit?site=${s.id}`}>details</Link> ·{' '}
                          <Link className="text-accent underline" href={`/seo/todos?site=${s.id}`}>
                            {open} open fix{open === 1 ? '' : 'es'}
                          </Link>
                        </p>
                      </>
                    ) : (
                      <p className="mt-3 text-[13px] text-ink-muted">Not audited yet.</p>
                    )}
                  </div>
                </Card>
              )
            })}
          </div>
        )}
      </section>

      <section>
        <SectionHeader title="AI answers" meta={<Link className="text-accent underline" href="/seo/visibility">questions and results</Link>} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {PROVIDERS.map((p) => {
            const r = runs.find((x) => x.provider === p.id)
            const on = !!providerKey(p)
            const answered = r && r.status === 'done' ? r.prompt_count : null
            return (
              <Card key={p.id} className="px-4 py-3">
                <p className="text-[12px] font-medium text-ink">{p.label}</p>
                {r && r.status === 'done' && r.mentioned != null ? (
                  <p className="mt-1 text-[13px] text-ink">
                    <span className="font-numeric text-[18px] font-semibold">{r.mentioned}</span>
                    <span className="text-ink-faint"> of {answered} answers name TapDash</span>
                  </p>
                ) : r && r.status === 'failed' ? (
                  <p className="mt-1 text-[12px] text-bad">Last run failed</p>
                ) : (
                  <p className="mt-1 text-[12px] text-ink-faint">{on ? 'Ready, not run yet' : 'Key not set'}</p>
                )}
                <p className="mt-1 text-[11px] text-ink-faint">{r ? when(r.finished_at ?? r.started_at) : on ? <Pill tone="accent">ready</Pill> : null}</p>
              </Card>
            )
          })}
        </div>
      </section>

      <section>
        <SectionHeader title="Top fixes" meta={<Link className="text-accent underline" href="/seo/todos">all fixes</Link>} />
        {fixes.length === 0 ? (
          <EmptyNote>No open fixes. Run an audit to build the list.</EmptyNote>
        ) : (
          <Card>
            <ul className="divide-y divide-line">
              {fixes.slice(0, 6).map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <Link href={`/seo/todos/${f.id}`} className="min-w-0 truncate text-[13px] text-ink hover:text-accent">
                    {f.payload.fix.title} <span className="text-ink-faint">· {f.site_name}</span>
                  </Link>
                  <CheckPill status={f.payload.fix.severity === 'fail' ? 'fail' : f.payload.fix.severity === 'unknown' ? 'unknown' : 'warn'} />
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  )
}
