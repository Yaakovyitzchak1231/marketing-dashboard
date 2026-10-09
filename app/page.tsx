import Link from 'next/link'
import type { ReactNode } from 'react'
import { getDb } from '@/lib/db'
import { loadOverview } from '@/lib/leads/overview'
import { PageShell, DbNotConnected } from '@/components/app/PageShell'
import { Card, EmptyNote, SectionHeader } from '@/components/dashboard/primitives'
import { STAGE_LABELS } from '@/lib/leads/filters'
import { STAGES } from '@/lib/leads/types'
import { dateTime } from '@/components/leads/pills'
import { kickRecompute } from '@/lib/rules/kick'
import { AutoRefresh } from '@/components/ops/AutoRefresh'

export const dynamic = 'force-dynamic'

const fmt = (n: number) => n.toLocaleString('en-US')

/** Overview: where the leads stand. Every number is a count of stored rows. */
export default async function OverviewPage() {
  const db = getDb()
  if (!db) {
    return (
      <PageShell title="Overview">
        <DbNotConnected what="The overview" />
      </PageShell>
    )
  }
  const o = await loadOverview(db)
  // Keep stored Ready/Parked scores fresh without making this page wait.
  if (o.readiness && (o.readiness.rescoring || o.readiness.stale || o.readiness.scored < o.readiness.companies)) kickRecompute(db)
  const maxStage = Math.max(1, ...STAGES.map((s) => o.byStage[s]))
  return (
    <PageShell title="Overview" meta={`${fmt(o.companies)} leads · ${fmt(o.contacts)} email addresses`}>
      <AutoRefresh seconds={30} />
      <div className="flex flex-col gap-7 sm:gap-8">
        <section aria-labelledby="next-h">
          <SectionHeader id="next-h" title="What needs you" />
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-card border border-line bg-line shadow-card md:grid-cols-3 xl:grid-cols-6">
            <Tile label="Replies waiting" value={o.repliesWaiting} href="/replies" tone={o.repliesWaiting ? 'accent' : undefined} note="human replies, not yet answered" />
            <Tile label="Interested" value={o.interested} href="/replies#interested" note="from Instantly labels" />
            {o.readiness && o.readiness.scored > 0 ? (
              <Tile
                label="Ready"
                value={o.readiness.personalized + o.readiness.generic}
                href="/rules"
                note={`${fmt(o.readiness.personalized)} personalized · ${fmt(o.readiness.generic)} generic · ${fmt(o.readiness.parked)} parked${o.readiness.rescoring ? ' · re-scoring' : ''}`}
              />
            ) : (
              <Tile label="Ready to send" value={o.readyToSend} href="/leads?verification=valid" note="verified emails not in a campaign (lead rules not scored yet)" />
            )}
            <Tile label="Needs verification" value={o.needsVerificationCompanies} href="/leads?view=verify" note={`${fmt(o.unverifiedContacts)} unverified emails`} />
            <Tile label="Needs research" value={o.needsResearch} href="/leads?view=research" note={o.researchQueued ? `${fmt(o.researchQueued)} more queued` : 'no site or owner work done'} />
            <Tile label="In campaigns" value={o.inCampaigns} href="/leads?view=campaign" note="leads with Instantly activity" />
          </div>
        </section>

        {o.readiness && o.readiness.topReasons.length ? (
          <section aria-labelledby="parked-h">
            <SectionHeader id="parked-h" title="Why leads are parked" meta={<Link href="/rules" className="text-accent">Lead rules</Link>} />
            <Card className="px-4 py-3 text-[13px]">
              <ul className="space-y-0.5">
                {o.readiness.topReasons.map((r) => (
                  <li key={r.rule} className="text-ink-muted">
                    <b className="font-semibold tabular-nums text-ink">{fmt(r.n)}</b> {r.label}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[11px] text-ink-faint">
                Under each lead&apos;s pool rules · {fmt(o.readiness.scored)} of {fmt(o.readiness.companies)} leads scored
                {o.readiness.stale ? ` · ${fmt(o.readiness.stale)} waiting to refresh` : ''}
              </p>
            </Card>
          </section>
        ) : null}

        <div className="grid gap-7 sm:gap-8 lg:grid-cols-[minmax(0,1fr)_380px]">
          <section aria-labelledby="stage-h">
            <SectionHeader id="stage-h" title="Leads by stage" meta={<Link href="/leads?view=kanban" className="text-accent">Open board</Link>} />
            <Card>
              {o.companies === 0 ? (
                <EmptyNote>No leads yet. Import the Lead Master sheet or run Find leads.</EmptyNote>
              ) : (
                <ul className="divide-y divide-line-soft">
                  {STAGES.map((s) => {
                    // Bar length only: a layout fraction of the biggest stage, not a metric.
                    const fraction = o.byStage[s] / maxStage
                    return (
                    <li key={s}>
                      <Link href={`/leads?stage=${s}`} prefetch={false} className="grid grid-cols-[110px_minmax(0,1fr)_56px] items-center gap-3 px-4 py-2 text-[13px] hover:bg-canvas/70">
                        <span className="text-ink-muted">{STAGE_LABELS[s]}</span>
                        <span className="h-1.5 rounded-full bg-line-soft">
                          <span className="block h-1.5 rounded-full bg-accent/70" style={{ width: `${fraction * 100}%` }} />
                        </span>
                        <span className={`text-right tabular-nums ${o.byStage[s] ? 'text-ink' : 'text-ink-faint'}`}>{fmt(o.byStage[s])}</span>
                      </Link>
                    </li>
                    )
                  })}
                </ul>
              )}
            </Card>
          </section>

          <div className="flex flex-col gap-7 sm:gap-8">
            <section aria-labelledby="team-h">
              <SectionHeader id="team-h" title="Team at work" meta={<Link href="/team" className="text-accent">Team board</Link>} />
              <Card className="px-4 py-3 text-[13px]">
                <p className="text-ink">
                  <b className="font-semibold tabular-nums">{fmt(o.tasksActive)}</b> task{o.tasksActive === 1 ? '' : 's'} in progress ·{' '}
                  <b className="font-semibold tabular-nums">{fmt(o.tasksQueued)}</b> waiting
                  {o.approvalsPending ? (
                    <>
                      {' '}· <Link href="/team" className="font-semibold text-warn">{fmt(o.approvalsPending)} need your OK</Link>
                    </>
                  ) : null}
                </p>
                <p className="mt-1 text-[12px] text-ink-faint">
                  {o.agentsWorking.length
                    ? `Working now: ${o.agentsWorking.map((a) => `${a.display_name} (${a.tasks})`).join(', ')}`
                    : 'No one has a task checked out right now.'}
                </p>
              </Card>
            </section>

            <section aria-labelledby="act-h">
              <SectionHeader id="act-h" title="Latest activity" meta={<Link href="/activity" className="text-accent">All activity</Link>} />
              <Card>
                {o.recent.length ? (
                  <ul className="divide-y divide-line-soft" data-testid="recent-activity">
                    {o.recent.map((e) => (
                      <li key={e.id} className="px-4 py-2.5 text-[13px]">
                        <p className="break-words text-ink">{e.summary}</p>
                        <p className="text-[11px] tabular-nums text-ink-faint">
                          {dateTime(e.at)}
                          {e.actor_name ? ` · ${e.actor_name}` : ''}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyNote>Nothing logged yet.</EmptyNote>
                )}
              </Card>
            </section>
          </div>
        </div>
      </div>
    </PageShell>
  )
}

function Tile({ label, value, href, note, tone }: { label: string; value: number; href: string; note: ReactNode; tone?: 'accent' }) {
  return (
    <Link href={href} prefetch={false} className="group flex flex-col bg-surface px-4 py-3 hover:bg-canvas/60">
      <span className="text-[12px] text-ink-muted group-hover:text-ink">{label}</span>
      <span className={`mt-1 text-metric font-semibold tabular-nums ${tone === 'accent' ? 'text-accent' : 'text-ink'}`}>{fmt(value)}</span>
      <span className="mt-0.5 text-[11px] leading-snug text-ink-faint">{note}</span>
    </Link>
  )
}
