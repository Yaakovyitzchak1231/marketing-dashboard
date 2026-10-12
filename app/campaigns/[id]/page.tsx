import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db'
import { BUTTON, BUTTON_PRIMARY, PageShell, DbNotConnected } from '@/components/app/PageShell'
import { Card, EmptyNote, Pill, SectionHeader } from '@/components/dashboard/primitives'
import { place, shortDate } from '@/components/leads/pills'
import { INPUT, LABEL, Notice, TierPill } from '@/components/campaigns/ui'
import { CampaignTabs } from '@/components/campaign-steps/CampaignTabs'
import { ProfileSummaryCard } from '@/components/campaign-profiles/ProfileSummaryCard'
import { getCampaign, listStatuses } from '@/lib/campaigns/store'
import { getCampaignLead, listCampaignLeads, previewPick } from '@/lib/campaigns/leads'
import { pickableRuleSets, rulesWriter, tierCountsFor, TIER_WORDS, type Tier } from '@/lib/campaigns/evaluator'
import { overridesToLines, parsePick, type LeadPick } from '@/lib/campaigns/types'
import { listPools } from '@/lib/pools/store'
import { CONTACT_STATUSES, STAGES, VERIFICATION_STATUSES } from '@/lib/leads/types'
import {
  addFromSegmentAction, addLeadsByFilterAction, addLeadsByIdsAction, archiveCampaignAction, duplicateCampaignAction, makeOwnRulesAction,
  removeLeadsAction, updateCampaignLeadAction,
} from '@/app/actions/campaigns'
import { listSegments, type Segment } from '@/lib/segments/store'
import { InlineEditCell } from '@/components/edit/InlineEditCell'
import { HistoryDrawer } from '@/components/edit/HistoryDrawer'
import { isUndefinedTable } from '@/lib/db/errors'

export const dynamic = 'force-dynamic'

type SP = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''
const fmt = (n: number) => n.toLocaleString('en-US')
const TIERS: (Tier | 'not_scored')[] = ['ready_personalized', 'ready_generic', 'parked', 'not_scored']

/** One campaign: settings, its lead list with Ready / Parked + reasons, and the tools to build the list. */
export default async function CampaignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const { id: raw } = await params
  const sp = await searchParams
  if (!/^\d{1,15}$/.test(raw)) notFound()
  const id = Number(raw)
  const db = getDb()
  if (!db) {
    return (
      <PageShell title="Campaign">
        <DbNotConnected what="The campaigns workspace" />
      </PageShell>
    )
  }
  const campaign = await getCampaign(db, id)
  if (!campaign) notFound()

  const tier = (TIERS as string[]).includes(one(sp.tier)) ? (one(sp.tier) as Tier | 'not_scored') : null
  const filter = { q: one(sp.q) || null, state: one(sp.state) || null, tier, page: Number(one(sp.page)) || 1 }
  const leadId = Number(one(sp.lead))
  let pick: LeadPick | null = null
  try {
    pick = one(sp.preview) ? parsePick(Object.fromEntries(['pool', 'stage', 'contact_status', 'verification', 'state', 'tag', 'q'].map((k) => [k, one(sp[`f_${k}`]) || null]))) : null
  } catch {
    pick = null
  }
  const [list, statuses, ruleSets, counts, actors, editing, preview, pools, segmentState] = await Promise.all([
    listCampaignLeads(db, id, filter),
    listStatuses(db, { includeInactive: false }),
    pickableRuleSets(db, campaign.rule_set_id),
    tierCountsFor(db, campaign),
    db.query<{ id: string; display_name: string }>('select id, display_name from lp.actors where active order by kind, display_name').then((r) => r.rows),
    Number.isInteger(leadId) && leadId > 0 ? getCampaignLead(db, id, leadId) : Promise.resolve(null),
    pick ? previewPick(db, id, pick) : Promise.resolve(null),
    listPools(db),
    listSegments(db, { includeArchived: false })
      .then((segments) => ({ segments, needsMigration: false }))
      .catch((e) => {
        if (isUndefinedTable(e)) return { segments: [] as Segment[], needsMigration: true }
        throw e
      }),
  ])
  const { segments, needsMigration: segmentsNeedMigration } = segmentState
  const poolLabel: Record<string, string> = Object.fromEntries(pools.map((p) => [p.id, p.label]))
  const err = one(sp.error)
  const qs = (patch: Record<string, string | null>) => {
    const u = new URLSearchParams()
    for (const k of ['q', 'state', 'tier', 'page']) if (one(sp[k])) u.set(k, one(sp[k]))
    for (const [k, v] of Object.entries(patch)) {
      if (v) u.set(k, v)
      else u.delete(k)
    }
    return `/campaigns/${id}${u.size ? `?${u}` : ''}`
  }
  const statusKnown = statuses.some((s) => s.id === campaign.status)

  const notices: string[] = []
  if (one(sp.saved) && !one(sp.lead)) notices.push(one(sp.saved) === '0' ? 'Nothing changed.' : 'Saved.')
  if (one(sp.added)) notices.push(`Added ${fmt(Number(one(sp.added)))} lead${one(sp.added) === '1' ? '' : 's'}${Number(one(sp.already)) ? ` (${fmt(Number(one(sp.already)))} were already in it)` : ''}.${one(sp.missing) ? ` Not found: ${one(sp.missing)}.` : ''}${one(sp.seg_skipped) ? ` ${fmt(Number(one(sp.seg_skipped)))} from the segment were skipped (excluded, do-not-contact, or suppressed).` : ''}`)
  if (one(sp.removed)) notices.push(`Removed ${fmt(Number(one(sp.removed)))} lead${one(sp.removed) === '1' ? '' : 's'} from this campaign. The leads themselves are unchanged.`)

  return (
    <PageShell
      title={campaign.name}
      meta={
        <>
          <Link href="/campaigns" className="hover:text-ink">Campaigns</Link> · {poolLabel[campaign.pool] ?? campaign.pool} · {campaign.is_template ? 'template · ' : ''}
          {fmt(list.total)} lead{list.total === 1 ? '' : 's'}{filter.q || filter.state || filter.tier ? ' match' : ''} · updated {shortDate(campaign.updated_at)}
        </>
      }
      actions={
        <>
          <form action={duplicateCampaignAction}>
            <input type="hidden" name="campaign_id" value={id} />
            <button className={BUTTON}>Duplicate</button>
          </form>
          <form action={duplicateCampaignAction}>
            <input type="hidden" name="campaign_id" value={id} />
            <input type="hidden" name="as_template" value="yes" />
            <input type="hidden" name="with_leads" value="no" />
            <input type="hidden" name="name" value={`${campaign.name} (template)`.slice(0, 120)} />
            <button className={BUTTON}>Save as template</button>
          </form>
        </>
      }
    >
      <CampaignTabs campaignId={id} active="leads" />
      {err ? <Notice tone="bad">{err}</Notice> : null}
      {notices.map((n) => <Notice key={n} tone="good">{n}</Notice>)}
      <div className="mb-5">
        <ProfileSummaryCard db={db} campaignId={id} />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_330px]">
        <div className="min-w-0 space-y-6">
          <section aria-labelledby="ready-h">
            <SectionHeader
              id="ready-h"
              title="Ready or parked"
              meta={counts ? <>Rules: {counts.ruleSet.name} ({counts.ruleSet.via === 'picked' ? 'picked for this campaign' : counts.ruleSet.via === 'own' ? 'this campaign’s own' : counts.ruleSet.via === 'pool' ? 'the pool’s' : 'the default'}) · <Link className="hover:text-ink" href={`/rules/${counts.ruleSet.id}`}>edit rules</Link></> : 'Rules are not set up yet'}
            />
            <Card className="grid grid-cols-2 gap-px overflow-hidden bg-line-soft sm:grid-cols-4">
              {counts ? (
                TIERS.map((t) => (
                  <Link key={t} href={qs({ tier: filter.tier === t ? null : t, page: null })} className={`bg-surface px-4 py-3 hover:bg-canvas ${filter.tier === t ? 'ring-1 ring-inset ring-accent' : ''}`}>
                    <p className="text-[11.5px] text-ink-faint">{t === 'not_scored' ? 'Not scored yet' : TIER_WORDS[t]}</p>
                    <p className="text-[18px] font-semibold tabular-nums text-ink">{fmt(counts[t])}</p>
                  </Link>
                ))
              ) : (
                <p className="col-span-full bg-surface px-4 py-3 text-[13px] text-ink-muted">
                  Each lead will show Ready (personalized or generic) or Parked with the reason once the rules update is merged. Until then nothing is scored, and nothing here is a guess.
                </p>
              )}
            </Card>
            {rulesWriter && counts && counts.ruleSet.via !== 'own' ? (
              <form action={makeOwnRulesAction} className="mt-2">
                <input type="hidden" name="campaign_id" value={id} />
                <button className={BUTTON}>Give this campaign its own rules (copy of {counts.ruleSet.name})</button>
              </form>
            ) : null}
            <p className="mt-2 text-[11.5px] text-ink-faint">Only Ready leads can ever be uploaded, and only through Add to Instantly with your OK. Held leads (role-based-hold, needs-check) are never rejected or deleted here.</p>
          </section>

          <section aria-labelledby="leads-h">
            <SectionHeader id="leads-h" title="Leads" meta={list.pages > 1 ? `page ${list.page} of ${list.pages}` : null} />
            <form className="mb-3 flex flex-wrap items-end gap-2" action={`/campaigns/${id}`}>
              <label className={LABEL}>Search<input name="q" defaultValue={filter.q ?? ''} className={`${INPUT} w-48`} placeholder="name, site, email" /></label>
              <label className={LABEL}>State<input name="state" defaultValue={filter.state ?? ''} className={`${INPUT} w-16`} placeholder="MD" /></label>
              <label className={LABEL}>Status
                <select name="tier" defaultValue={filter.tier ?? ''} className={INPUT}>
                  <option value="">Any</option>
                  {TIERS.map((t) => <option key={t} value={t}>{t === 'not_scored' ? 'Not scored yet' : TIER_WORDS[t]}</option>)}
                </select>
              </label>
              <button className={BUTTON}>Filter</button>
              {filter.q || filter.state || filter.tier ? <Link className={BUTTON} href={`/campaigns/${id}`}>Clear</Link> : null}
            </form>
            <Card>
              {list.rows.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-left text-[13px]">
                    <thead className="border-b border-line text-[11.5px] uppercase tracking-[0.05em] text-ink-faint">
                      <tr>
                        <th className="w-8 px-3 py-2" />
                        <th className="px-2 py-2 font-medium">Lead</th>
                        <th className="px-3 py-2 font-medium">Email</th>
                        <th className="px-3 py-2 font-medium">Status</th>
                        <th className="px-3 py-2 font-medium">Why</th>
                        <th className="px-3 py-2 font-medium">Overrides</th>
                        <th className="px-3 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {list.rows.map((r) => {
                        const ct = r.contacts.find((c) => c.id === (r.contact_id ?? r.verdict?.contact_id)) ?? r.contacts[0] ?? null
                        const nOver = Object.keys(r.overrides).length
                        return (
                          <tr key={r.company_id} className={`border-b border-line-soft align-top last:border-0 ${editing?.company_id === r.company_id ? 'bg-accent-soft/40' : ''}`}>
                            <td className="px-3 py-2.5"><input type="checkbox" name="company_id" value={r.company_id} form="remove-form" aria-label={`Select ${r.name}`} /></td>
                            <td className="px-2 py-2.5">
                              <Link href={`/leads/${r.company_id}`} className="font-medium text-ink hover:text-accent">{r.name}</Link>
                              <p className="text-[11.5px] text-ink-faint">{[place(r.city, r.state), r.website_domain].filter(Boolean).join(' · ')}{r.tags.length ? ` · ${r.tags.join(', ')}` : ''}</p>
                            </td>
                            <td className="px-3 py-2.5">
                              {ct ? (
                                <>
                                  <span className="text-ink">{ct.email ?? '—'}</span>
                                  <p className="text-[11.5px] text-ink-faint">{ct.status} · {ct.verification_status}{r.contact_id ? ' · pinned' : ''}</p>
                                </>
                              ) : <span className="text-ink-faint">No email</span>}
                            </td>
                            <td className="px-3 py-2.5">
                              <TierPill tier={r.verdict?.tier ?? null} suppressedReason={r.suppressed?.reason ?? null} />
                              {r.verdict?.batch === 'role-inbox' ? <p className="mt-1 text-[11px] text-ink-faint">role-inbox batch</p> : null}
                              {r.verdict?.stale ? <p className="mt-1 text-[11px] text-ink-faint">changed since scored</p> : null}
                            </td>
                            <td className="max-w-[260px] px-3 py-2.5 text-[12px] text-ink-muted">
                              {r.verdict?.reasons.length ? (
                                <ul className="space-y-0.5">{r.verdict.reasons.map((x) => <li key={x.rule}>{x.label}{x.detail ? <span className="text-ink-faint"> — {x.detail}</span> : null}</li>)}</ul>
                              ) : r.verdict?.missing.length ? (
                                <span>Generic: no {r.verdict.missing.join(', ')}</span>
                              ) : r.verdict ? <span className="text-ink-faint">—</span> : null}
                            </td>
                            <td className="px-3 py-2.5 text-[12px] text-ink-muted">{nOver ? `${nOver} set` : <span className="text-ink-faint">none</span>}{r.note ? <p className="line-clamp-1 text-[11.5px] text-ink-faint">{r.note}</p> : null}</td>
                            <td className="px-3 py-2.5 text-right"><Link className={BUTTON} href={qs({ lead: String(r.company_id) }) + '#edit'}>Edit</Link></td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyNote>{list.total ? 'No leads match these filters.' : 'No leads in this campaign yet. Add them by filter or by id on the right.'}</EmptyNote>
              )}
            </Card>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <form id="remove-form" action={removeLeadsAction} className="flex items-center gap-2">
                <input type="hidden" name="campaign_id" value={id} />
                <label className="flex items-center gap-1 text-[12px] text-ink-muted"><input type="checkbox" name="confirm" value="yes" /> confirm</label>
                <button className={BUTTON}>Remove selected from this campaign</button>
              </form>
              {list.pages > 1 ? (
                <div className="flex gap-2">
                  {list.page > 1 ? <Link className={BUTTON} href={qs({ page: String(list.page - 1) })}>Previous</Link> : null}
                  {list.page < list.pages ? <Link className={BUTTON} href={qs({ page: String(list.page + 1) })}>Next</Link> : null}
                </div>
              ) : null}
            </div>
          </section>
        </div>

        <aside className="space-y-5">
          {editing ? (
            <section aria-labelledby="edit-h" id="edit">
              <SectionHeader id="edit-h" title={`Edit: ${editing.name}`} meta={<Link className="hover:text-ink" href={qs({ lead: null })}>close</Link>} />
              <Card className="p-3">
                {one(sp.saved) ? <p className="mb-2 text-[12px] text-good">Saved.</p> : null}
                <form action={updateCampaignLeadAction} className="space-y-3">
                  <input type="hidden" name="campaign_id" value={id} />
                  <input type="hidden" name="company_id" value={editing.company_id} />
                  <label className={LABEL}>Personalization overrides (one per line: field = value)
                    <textarea name="overrides_text" rows={5} defaultValue={overridesToLines(editing.overrides)} className={`${INPUT} font-mono text-[12px]`} placeholder={'firstName = Dana\nstoreDetail = family-owned since 1952'} />
                  </label>
                  {editing.verdict && Object.keys(editing.verdict.merge).length ? (
                    <p className="text-[11.5px] text-ink-faint">From the rules now: {Object.entries(editing.verdict.merge).map(([k, v]) => `${k} = ${v}`).join(' · ')}</p>
                  ) : null}
                  <label className={LABEL}>Send to
                    <select name="contact_id" defaultValue={editing.contact_id ?? ''} className={INPUT}>
                      <option value="">Let the rules pick</option>
                      {editing.contacts.map((c) => <option key={c.id} value={c.id}>{c.email ?? `contact ${c.id}`} ({c.status})</option>)}
                    </select>
                  </label>
                  <label className={LABEL}>Tags (on the lead, comma-separated)<input name="tags" defaultValue={editing.tags.join(', ')} className={INPUT} /></label>
                  <label className={LABEL}>Note<textarea name="note" rows={2} defaultValue={editing.note ?? ''} maxLength={2000} className={INPUT} /></label>
                  {editing.verdict?.reasons.length ? (
                    <div className="text-[12px] text-ink-muted">
                      <p className="font-medium text-ink">Why it’s parked</p>
                      <ul className="mt-1 list-disc pl-4">{editing.verdict.reasons.map((x) => <li key={x.rule}>{x.label}{x.detail ? ` — ${x.detail}` : ''}{x.standing ? ' (fixed rule)' : ''}</li>)}</ul>
                    </div>
                  ) : null}
                  <button className={BUTTON_PRIMARY}>Save lead</button>
                </form>
              </Card>
            </section>
          ) : null}

          <section aria-labelledby="add-h" id="add">
            <SectionHeader id="add-h" title="Add leads" />
            <Card className="space-y-4 p-3">
              <form action={addLeadsByFilterAction} className="space-y-2">
                <input type="hidden" name="campaign_id" value={id} />
                <div className="grid grid-cols-2 gap-2">
                  <label className={LABEL}>Pool
                    <select name="pool" defaultValue={pick?.pool ?? campaign.pool} className={INPUT}>
                      <option value="">Any</option>
                      {pools.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                    </select>
                  </label>
                  <label className={LABEL}>Stage
                    <select name="stage" defaultValue={pick?.stage ?? ''} className={INPUT}>
                      <option value="">Any</option>
                      {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </label>
                  <label className={LABEL}>Email status
                    <select name="contact_status" defaultValue={pick?.contact_status ?? ''} className={INPUT}>
                      <option value="">Any</option>
                      {CONTACT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </label>
                  <label className={LABEL}>Verification
                    <select name="verification" defaultValue={pick?.verification ?? ''} className={INPUT}>
                      <option value="">Any</option>
                      {VERIFICATION_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </label>
                  <label className={LABEL}>State<input name="state" defaultValue={pick?.state ?? ''} className={INPUT} placeholder="MD" /></label>
                  <label className={LABEL}>Tag<input name="tag" defaultValue={pick?.tag ?? ''} className={INPUT} /></label>
                </div>
                <label className={LABEL}>Search<input name="q" defaultValue={pick?.q ?? ''} className={INPUT} placeholder="name, site, city, email" /></label>
                {preview ? (
                  <p className="text-[12px] text-ink">
                    {fmt(preview.matching)} lead{preview.matching === 1 ? '' : 's'} match; {fmt(preview.already)} already in this campaign, so {fmt(preview.matching - preview.already)} would be added.
                    <input type="hidden" name="confirm" value="yes" />
                  </p>
                ) : null}
                <div className="flex gap-2">
                  <button className={preview ? BUTTON_PRIMARY : BUTTON}>{preview ? `Add ${fmt(preview.matching - preview.already)}` : 'Count matches'}</button>
                  {preview ? <Link className={BUTTON} href={`/campaigns/${id}#add`}>Change filter</Link> : null}
                </div>
              </form>
              <form action={addLeadsByIdsAction} className="space-y-2 border-t border-line-soft pt-3">
                <input type="hidden" name="campaign_id" value={id} />
                <label className={LABEL}>By hand: lead ids (from the Leads screen), comma or space separated
                  <input name="company_ids" required className={INPUT} placeholder="1204, 1311" />
                </label>
                <button className={BUTTON}>Add</button>
              </form>

              <div className="border-t border-line-soft pt-3">
                <p className={LABEL}>From segment</p>
                {segmentsNeedMigration ? (
                  <EmptyNote>Needs migration 0024 — it runs on the next production deploy.</EmptyNote>
                ) : segments.length === 0 ? (
                  <EmptyNote>No segments yet — build one from Leads → Advanced filters → Save as segment.</EmptyNote>
                ) : (
                  <form action={addFromSegmentAction} className="space-y-2">
                    <input type="hidden" name="campaign_id" value={id} />
                    <label className={LABEL}>Segment
                      <select name="segment_id" required className={INPUT} defaultValue="">
                        <option value="" disabled>Pick a segment…</option>
                        {segments.map((seg) => <option key={seg.id} value={seg.id}>{seg.name}</option>)}
                      </select>
                    </label>
                    <label className="flex items-center gap-1 text-[12px] text-ink-muted">
                      <input type="checkbox" name="keep_syncing" /> keep syncing (re-running this later adds any new matches; already-added leads are untouched)
                    </label>
                    {segments.length > 1 ? (
                      <fieldset className={LABEL}>
                        <legend>Exclude segments (never added, even if they also match)</legend>
                        <div className="mt-1 max-h-28 space-y-1 overflow-y-auto rounded border border-line-soft p-2">
                          {segments.map((seg) => (
                            <label key={seg.id} className="flex items-center gap-1 text-[12px] text-ink-muted">
                              <input type="checkbox" name="exclude_segment_id" value={seg.id} /> {seg.name}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    ) : null}
                    <button className={BUTTON}>Add from segment</button>
                  </form>
                )}
              </div>
            </Card>
          </section>

          <section aria-labelledby="quick-h">
            <SectionHeader id="quick-h" title="Settings" meta={<HistoryDrawer type="campaign" id={id} />} />
            <Card className="space-y-2 p-3">
              <label className={LABEL}>Name<InlineEditCell type="campaign" id={id} field="name" value={campaign.name} label="Campaign name" className="w-full" /></label>
              <label className={LABEL}>Goal<InlineEditCell type="campaign" id={id} field="goal" value={campaign.goal} label="Goal" placeholder="No goal set" className="w-full" /></label>
              <label className={LABEL}>Notes<InlineEditCell type="campaign" id={id} field="notes" value={campaign.notes} label="Notes" placeholder="No notes" className="w-full" /></label>
              <label className={LABEL}>
                Status
                <InlineEditCell
                  type="campaign"
                  id={id}
                  field="status"
                  value={campaign.status}
                  label="Status"
                  options={statuses.map((s) => ({ value: s.id, label: s.label })).concat(statusKnown ? [] : [{ value: campaign.status, label: campaign.status }])}
                />
              </label>
              <label className={LABEL}>
                Pool
                <InlineEditCell
                  type="campaign"
                  id={id}
                  field="pool"
                  value={campaign.pool}
                  label="Pool"
                  options={pools.map((p) => ({ value: p.id, label: p.label })).concat(pools.some((p) => p.id === campaign.pool) ? [] : [{ value: campaign.pool, label: campaign.pool }])}
                />
              </label>
              <label className={LABEL}>
                Owner
                <InlineEditCell
                  type="campaign"
                  id={id}
                  field="owner"
                  value={campaign.owner ?? ''}
                  label="Owner"
                  options={[{ value: '', label: 'Nobody' }, ...actors.map((a) => ({ value: a.id, label: a.display_name }))]}
                />
              </label>
              <label className={LABEL}>
                Rules
                {ruleSets.length ? (
                  <InlineEditCell
                    type="campaign"
                    id={id}
                    field="rule_set_id"
                    value={campaign.rule_set_id == null ? '' : String(campaign.rule_set_id)}
                    label="Rules"
                    options={[{ value: '', label: 'The pool’s rules' }, ...ruleSets.map((r) => ({ value: String(r.id), label: `${r.name} (${r.scope})` }))]}
                  />
                ) : (
                  <span className="block text-[12px] text-ink-muted">The pool’s rules (rules update not merged yet)</span>
                )}
              </label>
              <label className={LABEL}>
                Template (shown under Templates; new campaigns can start from it)
                <InlineEditCell
                  type="campaign"
                  id={id}
                  field="is_template"
                  value={campaign.is_template ? 'true' : 'false'}
                  label="Template"
                  options={[{ value: 'false', label: 'No' }, { value: 'true', label: 'Yes' }]}
                />
              </label>
              <p className="text-[11px] text-ink-faint">Click a value to change it; it saves on its own, one field at a time, and each change is in History above. Pool and rules can only be changed by a person.</p>
            </Card>
          </section>

          <section aria-labelledby="archive-h">
            <SectionHeader id="archive-h" title="Archive" />
            <form action={archiveCampaignAction} className="mt-3 flex items-center gap-2">
              <input type="hidden" name="campaign_id" value={id} />
              <label className="flex items-center gap-1 text-[12px] text-ink-muted"><input type="checkbox" name="confirm" value="yes" required /> sure</label>
              <button className={BUTTON}>Archive campaign</button>
              <Pill tone="neutral">{campaign.status}</Pill>
            </form>
            <p className="mt-2 text-[11.5px] text-ink-faint">Every change here is in Activity with who made it and old → new. Nothing on this page sends to Instantly.</p>
          </section>
        </aside>
      </div>
    </PageShell>
  )
}
