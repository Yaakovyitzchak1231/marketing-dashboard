import { getDb } from '@/lib/db'
import { DbNotConnected, PageFrame, btnCls, inputCls, primaryBtnCls } from '@/components/ops/bits'
import { Card, EmptyNote, Pill, SectionHeader } from '@/components/dashboard/primitives'
import { Notice } from '@/components/rules/bits'
import { TD, TH } from '@/components/reports/bits'
import { listScoreModels } from '@/lib/scoring/engine'
import { recomputeAllScoresAction, saveScoreModelRulesAction } from '@/app/actions/scoring'
import { isUndefinedTable } from '@/lib/db/errors'

export const dynamic = 'force-dynamic'

export default async function ScoringSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const db = getDb()
  if (!db) {
    return (
      <PageFrame title="Scoring" meta="Engagement and Fit score models">
        <DbNotConnected what="Scoring" />
      </PageFrame>
    )
  }

  let models: Awaited<ReturnType<typeof listScoreModels>> = []
  let needsMigration = false
  try {
    models = await listScoreModels(db)
  } catch (e) {
    if (isUndefinedTable(e)) needsMigration = true
    else throw e
  }

  return (
    <PageFrame
      title="Scoring"
      meta="Rule-based points beside the AI fit tiers: Engagement tracks how much a lead has actually engaged (opens, clicks, replies, meetings); Fit tracks how well a lead matches a campaign's own ICP and buying-signal rules. Points can expire; crossing a threshold (e.g. Hot) is its own event other automations can watch for."
    >
      <Notice error={sp.error} saved={sp.saved} />

      {needsMigration ? (
        <Card className="p-4">
          <p className="text-[13px] text-ink-muted">Needs migration 0030 — it runs on the next production deploy.</p>
        </Card>
      ) : (
        <>
          <section className="mb-6">
            <SectionHeader
              title="Models"
              meta={
                <form action={recomputeAllScoresAction}>
                  <button type="submit" className={btnCls}>
                    Recompute all now
                  </button>
                </form>
              }
            />
            {!models.length ? (
              <EmptyNote>No score models yet.</EmptyNote>
            ) : (
              <div className="flex flex-col gap-4">
                {models.map((m) => (
                  <Card key={m.id} className="p-4">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold text-ink">{m.name}</span>
                      <Pill tone={m.kind === 'engagement' ? 'accent' : 'good'}>{m.kind === 'engagement' ? 'Engagement' : 'Fit'}</Pill>
                      <Pill tone="neutral">{m.entity}</Pill>
                      {m.campaign_id ? <Pill tone="neutral">Campaign {m.campaign_id}</Pill> : <Pill tone="neutral">Default (every campaign)</Pill>}
                      {!m.active ? <Pill tone="warn">Inactive</Pill> : null}
                    </div>

                    {m.rules.length ? (
                      <table className="mb-3 w-full border-collapse text-[12.5px]">
                        <thead>
                          <tr className="border-b border-line">
                            <th className={TH}>Event</th>
                            <th className={TH}>Label</th>
                            <th className={TH}>Points</th>
                            <th className={TH}>Expires after</th>
                          </tr>
                        </thead>
                        <tbody>
                          {m.rules.map((r) => (
                            <tr key={r.rule_key} className="border-b border-line/60">
                              <td className={TD}>
                                <code className="font-numeric text-[12px]">{r.event_type}</code>
                              </td>
                              <td className={TD}>{r.label}</td>
                              <td className={TD}>{r.points > 0 ? `+${r.points}` : r.points}</td>
                              <td className={TD}>{r.expires_after_days ? `${r.expires_after_days} days` : 'Never'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p className="mb-3 text-[12.5px] text-ink-faint">
                        {m.kind === 'fit' ? 'No signal rules yet — add approved signal_rule items to this campaign’s profile.' : 'No rules yet.'}
                      </p>
                    )}

                    {m.thresholds.length ? (
                      <p className="mb-3 text-[12px] text-ink-muted">
                        Thresholds: {m.thresholds.map((t) => `${t.label} \u2265 ${t.min}`).join(', ')}
                      </p>
                    ) : null}

                    <details>
                      <summary className="cursor-pointer text-[12px] text-ink-muted hover:text-ink">Edit rules (JSON)</summary>
                      <form action={saveScoreModelRulesAction} className="mt-2 flex flex-col gap-2">
                        <input type="hidden" name="id" value={m.id} />
                        <input type="hidden" name="name" value={m.name} />
                        <input type="hidden" name="entity" value={m.entity} />
                        <input type="hidden" name="kind" value={m.kind} />
                        <input type="hidden" name="campaign_id" value={m.campaign_id ?? ''} />
                        <label className="text-[11px] font-semibold uppercase tracking-[0.05em] text-ink-faint">
                          Rules: [{'{'}rule_key, label, event_type, points, expires_after_days?{'}'}, ...]
                        </label>
                        <textarea name="rules_json" rows={6} defaultValue={JSON.stringify(m.rules, null, 2)} className={`${inputCls} font-mono text-[12px]`} />
                        <label className="text-[11px] font-semibold uppercase tracking-[0.05em] text-ink-faint">Thresholds: [{'{'}key, label, min{'}'}, ...]</label>
                        <textarea name="thresholds_json" rows={2} defaultValue={JSON.stringify(m.thresholds, null, 2)} className={`${inputCls} font-mono text-[12px]`} />
                        <label className="text-[11px] font-semibold uppercase tracking-[0.05em] text-ink-faint" htmlFor={`max_points_${m.id}`}>
                          Score cap (empty = no cap)
                        </label>
                        <input id={`max_points_${m.id}`} name="max_points" type="number" min={1} step={1} inputMode="numeric" defaultValue={m.max_points ?? ''} className={`${inputCls} tabular-nums sm:max-w-[10rem]`} />
                        <div>
                          <button type="submit" className={primaryBtnCls}>
                            Save
                          </button>
                        </div>
                      </form>
                    </details>
                  </Card>
                ))}
              </div>
            )}
          </section>

          <p className="text-[12px] text-ink-faint">
            Engagement and Fit scores also show on each lead&rsquo;s page and as an optional leads-table column. A nightly job (&ldquo;score_refresh&rdquo;, on the Jobs screen) recomputes every lead so expired points drop off on their own.
          </p>
        </>
      )}
    </PageFrame>
  )
}
