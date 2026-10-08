import Link from 'next/link'
import { PageShell, BUTTON } from '@/components/app/PageShell'
import { Card, SectionHeader, EmptyNote } from '@/components/dashboard/primitives'
import { VerifyButton } from '@/components/verify/VerifyButton'
import { ConfirmAction } from '@/components/reports/ConfirmAction'
import { ActionNote } from '@/components/reports/Note'
import { Count, LevelPill, SampleBanner, SourceErrors, TD, TDN, TH, fmtInt } from '@/components/reports/bits'
import { campaignSwitchAction } from '@/app/actions/reports'
import { loadReportInputs, rangeDays } from '@/lib/reports/load'
import { campaignRunway, formatDays, segmentRunway, RUNWAY_WARN_DAYS } from '@/lib/reports/runway'
import { SEGMENT_LABEL } from '@/lib/reports/meta'
import { actionsEnabled } from '@/lib/instantly/writer'

export const dynamic = 'force-dynamic'

export default async function RunwayPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const inp = await loadReportInputs('7d')
  const days = rangeDays(inp.data)
  const campaigns = inp.data.campaigns.map((c) => campaignRunway(c, inp.meta.get(c.id), days))
  const segments = inp.pools ? segmentRunway(inp.pools, campaigns) : []
  const canAct = actionsEnabled() && !inp.sample
  const noSegment = campaigns.filter((c) => !c.segment && c.status === 'active').length
  const errors = [
    ...(!inp.data.configured ? ['Instantly is not connected (INSTANTLY_API_KEY), so loaded leads and pace are not shown.'] : []),
    ...(!inp.db ? ['The lead database is not connected (DATABASE_URL), so unused verified leads are not counted.'] : []),
    ...(inp.dbError ? [inp.dbError] : []),
    ...inp.data.errors.map((e) => `${e.source}: ${e.message}`),
  ]
  const live = campaigns.filter((c) => c.status === 'active' || c.status === 'paused' || (c.remaining !== null && c.remaining > 0))

  return (
    <PageShell
      title="Lead runway"
      meta={`How many leads are left to email and how long they last at the pace of the last ${days} days. Under ${RUNWAY_WARN_DAYS} days gets a warning.`}
      actions={
        <Link href="/reports" className={BUTTON} prefetch={false}>
          All reports
        </Link>
      }
    >
      {inp.sample ? <SampleBanner /> : null}
      <ActionNote note={sp.note} tone={sp.tone} />
      <SourceErrors errors={errors} />

      <section aria-labelledby="seg-h" className="mb-8">
        <SectionHeader id="seg-h" title="By segment" meta="Verified and never emailed + loaded in Instantly and not yet contacted" />
        {segments.length === 0 ? (
          <Card>
            <EmptyNote>{inp.db ? 'No segments with leads or campaigns yet.' : 'Connect the lead database to count unused leads per segment.'}</EmptyNote>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {segments.map((s) => (
              <Card key={s.segment} className="px-4 py-4">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-[13px] font-semibold text-ink">{SEGMENT_LABEL[s.segment]}</h3>
                  <LevelPill level={s.level} />
                </div>
                <p className="mt-2 font-numeric text-[26px] font-semibold tabular-nums tracking-[-0.02em] text-ink" data-testid={`seg-days-${s.segment}`}>
                  {s.level === 'not_sending' ? 'Not sending' : formatDays(s.days)}
                </p>
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px]">
                  <dt className="text-ink-faint">Verified, unused</dt>
                  <dd className="text-right font-numeric tabular-nums">{fmtInt(s.ready)}</dd>
                  <dt className="text-ink-faint">Loaded, not contacted</dt>
                  <dd className="text-right font-numeric tabular-nums">
                    <Count v={s.loadedRemaining} />
                  </dd>
                  <dt className="text-ink-faint">Contacted per day</dt>
                  <dd className="text-right font-numeric tabular-nums">
                    <Count v={s.pacePerDay} />
                  </dd>
                  <dt className="text-ink-faint">Still to verify</dt>
                  <dd className="text-right font-numeric tabular-nums">{fmtInt(s.unverified)}</dd>
                </dl>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link href={`/find?segment=${s.segment === 'ai_agency' ? 'ai_agency' : 'jeweler'}`} prefetch={false} className={BUTTON}>
                    Find more leads
                  </Link>
                  {s.unverified > 0 ? (
                    <VerifyButton filter={{ segment: s.segment, verification_status: 'unverified' }} label={`Verify ${fmtInt(s.unverified)} unverified`} />
                  ) : null}
                </div>
              </Card>
            ))}
          </div>
        )}
        {noSegment > 0 ? (
          <p className="mt-2 text-[12px] text-ink-faint">
            {noSegment} sending campaign{noSegment === 1 ? ' has' : 's have'} no segment set, so {noSegment === 1 ? 'it isn’t' : 'they aren’t'} counted above.{' '}
            <Link href="/reports/costs#campaign-setup" className="text-accent">
              Set segments
            </Link>
          </p>
        ) : null}
      </section>

      <section aria-labelledby="cmp-h">
        <SectionHeader id="cmp-h" title="By campaign" meta={`Pace = new leads contacted in the last ${days} days ÷ ${days}`} />
        <Card className="overflow-x-auto">
          {live.length === 0 ? (
            <EmptyNote>{inp.data.configured ? 'No active or paused campaigns.' : 'Connect Instantly to see campaign runway.'}</EmptyNote>
          ) : (
            <table className="w-full min-w-[760px] border-collapse">
              <thead className="border-b border-line">
                <tr>
                  <th className={TH}>Campaign</th>
                  <th className={`${TH} text-right`}>Not yet contacted</th>
                  <th className={`${TH} text-right`}>Contacted ({days}d)</th>
                  <th className={`${TH} text-right`}>Per day</th>
                  <th className={`${TH} text-right`}>Days left</th>
                  <th className={TH}>Status</th>
                  <th className={TH}>Action</th>
                </tr>
              </thead>
              <tbody>
                {live.map((c) => (
                  <tr key={c.id} className="border-b border-line-soft last:border-0" data-testid="runway-row">
                    <td className={TD}>
                      <div className="font-medium">{c.name}</div>
                      <div className="text-[11px] text-ink-faint">
                        {c.status}
                        {c.segment ? ` · ${SEGMENT_LABEL[c.segment]}` : ''}
                        {c.angle ? ` · ${c.angle}` : ''}
                      </div>
                    </td>
                    <td className={TDN}>
                      <Count v={c.remaining} />
                    </td>
                    <td className={TDN}>
                      <Count v={c.contactedInWindow} />
                    </td>
                    <td className={TDN}>
                      <Count v={c.pacePerDay} />
                    </td>
                    <td className={TDN}>{c.level === 'not_sending' ? '—' : formatDays(c.days)}</td>
                    <td className={TD}>
                      <LevelPill level={c.level} />
                    </td>
                    <td className={TD}>
                      <div className="flex flex-wrap gap-1.5">
                        {(c.level === 'low' || c.level === 'out') && c.segment ? (
                          <Link href={`/find?segment=${c.segment === 'ai_agency' ? 'ai_agency' : 'jeweler'}`} prefetch={false} className={BUTTON}>
                            Find more leads
                          </Link>
                        ) : null}
                        {c.status === 'active' ? (
                          <ConfirmAction
                            action={campaignSwitchAction}
                            fields={{ kind: 'pause', campaign_id: c.id, campaign_name: c.name, return_to: '/reports/runway' }}
                            label="Pause"
                            confirmText={`Pause “${c.name}” in Instantly? Sending stops until you resume.`}
                            confirmLabel="Pause campaign"
                            disabled={!canAct}
                            disabledReason={inp.sample ? 'Sample data' : 'Instantly actions are off on this deploy'}
                          />
                        ) : c.status === 'paused' ? (
                          <ConfirmAction
                            action={campaignSwitchAction}
                            fields={{ kind: 'resume', campaign_id: c.id, campaign_name: c.name, return_to: '/reports/runway' }}
                            label="Resume"
                            confirmText={`Resume “${c.name}” in Instantly? It starts sending on its schedule.`}
                            confirmLabel="Resume campaign"
                            disabled={!canAct}
                            disabledReason={inp.sample ? 'Sample data' : 'Instantly actions are off on this deploy'}
                          />
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </section>
    </PageShell>
  )
}
