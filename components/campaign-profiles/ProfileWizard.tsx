'use client'

/**
 * The campaign profile wizard: Step 1 industry + ICP, Step 2 AI-assisted
 * setup (suggest, review, approve/reject), Step 3 manual add/edit per kind,
 * Step 4 UTM + KPIs -> Done. Talks to app/actions/campaign-profiles.ts, the
 * same functions an agent reaches through /api/ops.
 */
import { useState, useTransition } from 'react'
import { BUTTON, BUTTON_PRIMARY } from '@/components/app/PageShell'
import { Card, Pill, SectionHeader, EmptyNote, type PillTone } from '@/components/dashboard/primitives'
import { INPUT, LABEL, Notice } from '@/components/campaigns/ui'
import type { CampaignProfile, ItemKind, ItemStatus, ProfileItem, VerifyStatus } from '@/lib/campaign-profiles/store'
import { ITEM_KINDS } from '@/lib/campaign-profiles/store'
import type { Pool } from '@/lib/pools/store'
import type { SuggestOutcome } from '@/lib/campaign-profiles/suggest'
import {
  addProfileItemsAction, createPoolAction, getProfileAction, recheckProfileItemAction, setItemStatusAction,
  suggestProfileAction, updateProfileAction,
} from '@/app/actions/campaign-profiles'

const KIND_LABEL: Record<ItemKind, string> = {
  keyword: 'Keywords', topic: 'Topics', competitor: 'Competitors', feed: 'News / RSS feeds', forum: 'Forums & subreddits',
  directory: 'Directories & associations', trade_show: 'Trade shows', signal_rule: 'Buying-signal rules', fingerprint: 'Tech fingerprints',
  social_channel: 'Social channels', negative_keyword: 'Negative keywords', search_phrase: 'Search phrases', place_category: 'Place categories',
}

type Items = Record<ItemKind, ProfileItem[]>

export interface ProfileWizardProps {
  campaignId: number
  campaignName: string
  initial: { profile: CampaignProfile; items: Items; exists: boolean }
  pools: Pool[]
  aiConfigured: boolean
}

const csv = (v: string): string[] => v.split(',').map((s) => s.trim()).filter(Boolean)
const fromCsv = (arr?: string[] | null) => (arr ?? []).join(', ')

const VERIFY_TONE: Record<VerifyStatus, PillTone> = { ok: 'good', failed: 'bad', unchecked: 'neutral', not_applicable: 'neutral' }
const VERIFY_LABEL: Record<VerifyStatus, string> = { ok: 'checked', failed: 'couldn\u2019t verify', unchecked: 'not checked yet', not_applicable: 'n/a' }

function VerifyBadge({ item, onRecheck }: { item: ProfileItem; onRecheck: () => void }) {
  if (item.verify_status === 'not_applicable') return null
  return (
    <span className="inline-flex items-center gap-1">
      <Pill tone={VERIFY_TONE[item.verify_status]} title={item.verify_detail ?? undefined}>{VERIFY_LABEL[item.verify_status]}</Pill>
      {item.verify_status !== 'unchecked' ? (
        <button type="button" onClick={onRecheck} className="text-2xs text-ink-faint underline decoration-line underline-offset-2 hover:text-ink">
          Re-check
        </button>
      ) : null}
    </span>
  )
}

export function ProfileWizard({ campaignId, initial, pools: initialPools, aiConfigured }: ProfileWizardProps) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(initial.exists && initial.profile.setup_status !== 'draft' ? 3 : 1)
  const [profile, setProfile] = useState(initial.profile)
  const [items, setItems] = useState<Items>(initial.items)
  const [pools, setPools] = useState(initialPools)
  const [pending, startTransition] = useTransition()
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)

  // Step 1 form state
  const [industry, setIndustry] = useState(profile.industry ?? '')
  const [vertical, setVertical] = useState(profile.vertical ?? '')
  const [description, setDescription] = useState(profile.description ?? '')
  const [valueProp, setValueProp] = useState(profile.value_prop ?? '')
  const [businessTypes, setBusinessTypes] = useState(fromCsv(profile.icp.business_types))
  const [geographies, setGeographies] = useState(fromCsv(profile.icp.geographies))
  const [roles, setRoles] = useState(fromCsv(profile.icp.roles))
  const [exclude, setExclude] = useState(fromCsv(profile.icp.exclude))
  const [empMin, setEmpMin] = useState(profile.icp.size?.employees_min != null ? String(profile.icp.size.employees_min) : '')
  const [empMax, setEmpMax] = useState(profile.icp.size?.employees_max != null ? String(profile.icp.size.employees_max) : '')
  const [newPoolLabel, setNewPoolLabel] = useState('')
  const [showNewPool, setShowNewPool] = useState(false)

  // Step 2 (AI) state
  const [notes, setNotes] = useState('')
  const [exampleSites, setExampleSites] = useState('')
  const [lastSuggest, setLastSuggest] = useState<SuggestOutcome | null>(null)
  const [suggesting, setSuggesting] = useState(false)

  // Step 3 (manual add) state
  const [addKind, setAddKind] = useState<ItemKind>('keyword')
  const [addName, setAddName] = useState('')
  const [addValue, setAddValue] = useState('')

  // Step 4 state
  const [utmSource, setUtmSource] = useState(profile.utm.source ?? '')
  const [utmMedium, setUtmMedium] = useState(profile.utm.medium ?? '')
  const [utmCampaign, setUtmCampaign] = useState(profile.utm.campaign ?? '')
  const [utmContentRule, setUtmContentRule] = useState(profile.utm.content_rule ?? '')
  const [kpis, setKpis] = useState(profile.kpis)
  const [kpiMetric, setKpiMetric] = useState('')
  const [kpiTarget, setKpiTarget] = useState('')
  const [kpiPeriod, setKpiPeriod] = useState('month')

  function flash(tone: 'good' | 'bad', text: string) {
    setNotice({ tone, text })
    setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 4000)
  }

  function saveStep1() {
    const icp = {
      business_types: csv(businessTypes), geographies: csv(geographies), roles: csv(roles), exclude: csv(exclude),
      size: { employees_min: empMin ? Number(empMin) : null, employees_max: empMax ? Number(empMax) : null },
    }
    startTransition(async () => {
      const r = await updateProfileAction(campaignId, {
        industry: industry || null, vertical: vertical || null, description: description || null, value_prop: valueProp || null, icp,
      })
      if (!r.ok) return flash('bad', r.error)
      setProfile(r.data)
      flash('good', 'Saved.')
      setStep(2)
    })
  }

  function createPool() {
    if (!newPoolLabel.trim()) return
    startTransition(async () => {
      const r = await createPoolAction(newPoolLabel.trim())
      if (!r.ok) return flash('bad', r.error)
      setPools((p) => (p.some((x) => x.id === r.pool.id) ? p : [...p, r.pool]))
      setNewPoolLabel('')
      setShowNewPool(false)
      flash('good', `Added "${r.pool.label}" as a pool.`)
    })
  }

  function runSuggest() {
    if (!industry.trim()) return flash('bad', 'Type an industry first.')
    setSuggesting(true)
    startTransition(async () => {
      const r = await suggestProfileAction(campaignId, industry.trim(), notes || null, csv(exampleSites))
      setSuggesting(false)
      if (!r.ok) return flash('bad', r.error)
      setLastSuggest(r.result)
      if (!r.result.configured) return
      await reloadItems()
    })
  }

  // Full refresh of the profile + items from the server (suggest/approve/reject/add all mutate server-side).
  async function reloadItems() {
    const r = await getProfileAction(campaignId)
    if (r.ok) {
      setItems(r.data.items)
      setProfile(r.data.profile)
    }
  }

  function setStatus(ids: number[], status: ItemStatus) {
    startTransition(async () => {
      const r = await setItemStatusAction(ids, status, campaignId)
      if (!r.ok) return flash('bad', r.error)
      await reloadItems()
    })
  }

  function recheck(itemId: number) {
    startTransition(async () => {
      const r = await recheckProfileItemAction(itemId, campaignId)
      if (!r.ok) return flash('bad', r.error)
      await reloadItems()
    })
  }

  function addManualItem() {
    if (!addName.trim()) return flash('bad', 'Name is required.')
    startTransition(async () => {
      const r = await addProfileItemsAction(campaignId, [{ kind: addKind, name: addName.trim(), value: addValue.trim() || null, status: 'approved', source: 'human' }])
      if (!r.ok) return flash('bad', r.error)
      if (r.already.length) flash('bad', `"${addName}" is already there for ${KIND_LABEL[addKind]}.`)
      else flash('good', 'Added.')
      setAddName('')
      setAddValue('')
      await reloadItems()
    })
  }

  function addKpi() {
    if (!kpiMetric.trim() || !kpiTarget.trim()) return
    setKpis((k) => [...k, { metric: kpiMetric.trim(), target: Number(kpiTarget), period: kpiPeriod.trim() || 'month' }])
    setKpiMetric('')
    setKpiTarget('')
  }

  function saveStep4(finish: boolean) {
    startTransition(async () => {
      const r = await updateProfileAction(campaignId, {
        utm: { source: utmSource || null, medium: utmMedium || null, campaign: utmCampaign || null, content_rule: utmContentRule || null },
        kpis,
        setup_status: finish ? 'active' : 'reviewed',
      })
      if (!r.ok) return flash('bad', r.error)
      setProfile(r.data)
      flash('good', finish ? 'Profile is active.' : 'Saved.')
    })
  }

  const steps: { n: 1 | 2 | 3 | 4; label: string }[] = [
    { n: 1, label: 'Industry & ICP' },
    { n: 2, label: 'Suggest with AI' },
    { n: 3, label: 'Add & review items' },
    { n: 4, label: 'UTM + KPIs' },
  ]

  const suggestedByKind = ITEM_KINDS.map((k) => ({ kind: k, list: items[k].filter((i) => i.status === 'suggested') })).filter((x) => x.list.length)
  const approvedByKind = ITEM_KINDS.map((k) => ({ kind: k, list: items[k].filter((i) => i.status === 'approved') })).filter((x) => x.list.length)

  return (
    <div className="space-y-5">
      <nav aria-label="Profile setup steps" className="flex flex-wrap gap-1.5">
        {steps.map((s) => (
          <button
            key={s.n}
            type="button"
            onClick={() => setStep(s.n)}
            className={`rounded-card border px-2.5 py-1 text-xs ${step === s.n ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-muted hover:text-ink'}`}
          >
            {s.n}. {s.label}
          </button>
        ))}
      </nav>

      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}

      {step === 1 ? (
        <Card className="space-y-3 p-4">
          <SectionHeader title="What industry, and who do you sell to?" />
          <label className={LABEL}>
            Industry
            <input className={INPUT} value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="e.g. Independent jewelers, Dental clinics, AI agencies" />
          </label>
          <label className={LABEL}>
            Vertical (optional, more specific)
            <input className={INPUT} value={vertical} onChange={(e) => setVertical(e.target.value)} placeholder="e.g. Fast casual, General dentistry" />
          </label>
          <div className="flex flex-wrap items-end gap-2">
            <label className={LABEL}>
              Pool (which rules/segment this campaign uses)
              <select className={INPUT} defaultValue="" onChange={(e) => { /* pool assignment happens on the campaign itself; see note below */ void e }}>
                <option value="" disabled>Pick a pool</option>
                {pools.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
            {showNewPool ? (
              <>
                <label className={LABEL}>
                  New pool label
                  <input className={INPUT} value={newPoolLabel} onChange={(e) => setNewPoolLabel(e.target.value)} placeholder="e.g. Restaurants" />
                </label>
                <button type="button" className={BUTTON} disabled={pending} onClick={createPool}>Create pool</button>
                <button type="button" className={BUTTON} onClick={() => setShowNewPool(false)}>Cancel</button>
              </>
            ) : (
              <button type="button" className={BUTTON} onClick={() => setShowNewPool(true)}>+ Create a new pool</button>
            )}
          </div>
          <label className={LABEL}>
            Business types (comma-separated)
            <input className={INPUT} value={businessTypes} onChange={(e) => setBusinessTypes(e.target.value)} placeholder="independent jeweler, chain jeweler" />
          </label>
          <label className={LABEL}>
            Geographies (comma-separated)
            <input className={INPUT} value={geographies} onChange={(e) => setGeographies(e.target.value)} placeholder="MD, VA, DC" />
          </label>
          <label className={LABEL}>
            Roles to reach (comma-separated)
            <input className={INPUT} value={roles} onChange={(e) => setRoles(e.target.value)} placeholder="owner, office manager" />
          </label>
          <label className={LABEL}>
            Exclude (comma-separated)
            <input className={INPUT} value={exclude} onChange={(e) => setExclude(e.target.value)} placeholder="franchise, chain over 20 locations" />
          </label>
          <div className="flex gap-3">
            <label className={LABEL}>
              Min employees
              <input className={`${INPUT} w-28`} type="number" min={0} value={empMin} onChange={(e) => setEmpMin(e.target.value)} />
            </label>
            <label className={LABEL}>
              Max employees
              <input className={`${INPUT} w-28`} type="number" min={0} value={empMax} onChange={(e) => setEmpMax(e.target.value)} />
            </label>
          </div>
          <label className={LABEL}>
            Value prop (one line)
            <input className={INPUT} value={valueProp} onChange={(e) => setValueProp(e.target.value)} placeholder="e.g. Lower processing fees with same-day payout" />
          </label>
          <label className={LABEL}>
            Description (optional, a paragraph)
            <textarea className={`${INPUT} min-h-[90px]`} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <button type="button" className={BUTTON_PRIMARY} disabled={pending} onClick={saveStep1}>Save &amp; continue</button>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card className="space-y-3 p-4">
          <SectionHeader title="Suggest with AI" meta={aiConfigured ? null : 'No AI provider configured'} />
          {!aiConfigured ? (
            <EmptyNote>AI suggestions need an AI provider — add one in Settings. Manual entry below still works.</EmptyNote>
          ) : (
            <>
              <label className={LABEL}>
                ICP notes (optional)
                <textarea className={`${INPUT} min-h-[60px]`} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything about your ideal customer the AI should know" />
              </label>
              <label className={LABEL}>
                Example customer websites (optional, comma-separated)
                <input className={INPUT} value={exampleSites} onChange={(e) => setExampleSites(e.target.value)} placeholder="https://example-customer.com" />
              </label>
              <button type="button" className={BUTTON_PRIMARY} disabled={pending || suggesting || !industry.trim()} onClick={runSuggest}>
                {suggesting ? 'Thinking…' : 'Suggest with AI'}
              </button>
              {lastSuggest && lastSuggest.configured ? (
                <p className="text-xs text-ink-faint">
                  Saved {lastSuggest.items_saved} suggestion{lastSuggest.items_saved === 1 ? '' : 's'}
                  {lastSuggest.items_dropped ? `, dropped ${lastSuggest.items_dropped} invalid one${lastSuggest.items_dropped === 1 ? '' : 's'}` : ''}
                  {' · '}checked: {lastSuggest.verified_ok} ok, {lastSuggest.verified_failed} couldn&rsquo;t verify, {lastSuggest.not_applicable} n/a.
                  Review and approve below &mdash; nothing is auto-approved.
                </p>
              ) : null}
            </>
          )}
          {suggestedByKind.length ? (
            <div className="space-y-4 border-t border-line pt-3">
              {suggestedByKind.map(({ kind, list }) => (
                <div key={kind}>
                  <div className="mb-1.5 flex items-center justify-between">
                    <h3 className="text-xs font-medium text-ink-muted">{KIND_LABEL[kind]} ({list.length})</h3>
                    <button type="button" className={BUTTON} disabled={pending} onClick={() => setStatus(list.map((i) => i.id), 'approved')}>Approve all</button>
                  </div>
                  <ul className="space-y-1.5">
                    {list.map((it) => (
                      <li key={it.id} className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-line px-2.5 py-1.5">
                        <div className="min-w-0">
                          <p className="truncate text-sm text-ink">{it.name}{it.value ? <span className="text-ink-faint"> &middot; {it.value}</span> : null}</p>
                          {it.rationale ? <p className="truncate text-xs text-ink-faint">{it.rationale}</p> : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <VerifyBadge item={it} onRecheck={() => recheck(it.id)} />
                          <button type="button" className={BUTTON} disabled={pending} onClick={() => setStatus([it.id], 'approved')}>Approve</button>
                          <button type="button" className={BUTTON} disabled={pending} onClick={() => setStatus([it.id], 'rejected')}>Reject</button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : null}
          <button type="button" className={BUTTON} onClick={() => setStep(3)}>Continue</button>
        </Card>
      ) : null}

      {step === 3 ? (
        <Card className="space-y-4 p-4">
          <SectionHeader title="Add & review items" />
          <div className="flex flex-wrap items-end gap-2 border-b border-line pb-3">
            <label className={LABEL}>
              Kind
              <select className={INPUT} value={addKind} onChange={(e) => setAddKind(e.target.value as ItemKind)}>
                {ITEM_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </label>
            <label className={LABEL}>
              Name
              <input className={INPUT} value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="e.g. Toast" />
            </label>
            <label className={LABEL}>
              Value (URL, domain, query &mdash; depends on kind)
              <input className={INPUT} value={addValue} onChange={(e) => setAddValue(e.target.value)} placeholder="optional" />
            </label>
            <button type="button" className={BUTTON_PRIMARY} disabled={pending} onClick={addManualItem}>Add</button>
          </div>
          {approvedByKind.length ? (
            approvedByKind.map(({ kind, list }) => (
              <div key={kind}>
                <h3 className="mb-1.5 text-xs font-medium text-ink-muted">{KIND_LABEL[kind]} ({list.length})</h3>
                <ul className="flex flex-wrap gap-1.5">
                  {list.map((it) => (
                    <li key={it.id} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-canvas px-2.5 py-1 text-xs text-ink">
                      {it.name}
                      <VerifyBadge item={it} onRecheck={() => recheck(it.id)} />
                      <button type="button" className="text-ink-faint hover:text-bad" title="Archive" onClick={() => setStatus([it.id], 'archived')}>&times;</button>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <EmptyNote>No items approved yet. Add one above, or go back to Step 2 to get AI suggestions.</EmptyNote>
          )}
          <button type="button" className={BUTTON} onClick={() => setStep(4)}>Continue</button>
        </Card>
      ) : null}

      {step === 4 ? (
        <Card className="space-y-3 p-4">
          <SectionHeader title="UTM conventions & KPIs" />
          <div className="grid gap-2 sm:grid-cols-2">
            <label className={LABEL}>utm_source<input className={INPUT} value={utmSource} onChange={(e) => setUtmSource(e.target.value)} placeholder="tapdash" /></label>
            <label className={LABEL}>utm_medium<input className={INPUT} value={utmMedium} onChange={(e) => setUtmMedium(e.target.value)} placeholder="email" /></label>
            <label className={LABEL}>utm_campaign<input className={INPUT} value={utmCampaign} onChange={(e) => setUtmCampaign(e.target.value)} placeholder="dental-q4" /></label>
            <label className={LABEL}>Content rule (how utm_content is built)<input className={INPUT} value={utmContentRule} onChange={(e) => setUtmContentRule(e.target.value)} placeholder="step-{{stepNumber}}-{{variant}}" /></label>
          </div>
          <div>
            <h3 className="mb-1.5 text-xs font-medium text-ink-muted">KPIs</h3>
            <ul className="mb-2 space-y-1">
              {kpis.map((k, i) => (
                <li key={`${k.metric}-${i}`} className="flex items-center justify-between rounded-control border border-line px-2.5 py-1 text-sm">
                  <span>{k.metric}: {k.target} / {k.period}</span>
                  <button type="button" className="text-ink-faint hover:text-bad" onClick={() => setKpis((arr) => arr.filter((_, idx) => idx !== i))}>&times;</button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-end gap-2">
              <label className={LABEL}>Metric<input className={INPUT} value={kpiMetric} onChange={(e) => setKpiMetric(e.target.value)} placeholder="reply_rate" /></label>
              <label className={LABEL}>Target<input className={`${INPUT} w-24`} type="number" step="any" value={kpiTarget} onChange={(e) => setKpiTarget(e.target.value)} placeholder="0.05" /></label>
              <label className={LABEL}>Period<input className={`${INPUT} w-24`} value={kpiPeriod} onChange={(e) => setKpiPeriod(e.target.value)} placeholder="month" /></label>
              <button type="button" className={BUTTON} onClick={addKpi}>Add KPI</button>
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" className={BUTTON} disabled={pending} onClick={() => saveStep4(false)}>Save</button>
            <button type="button" className={BUTTON_PRIMARY} disabled={pending} onClick={() => saveStep4(true)}>Done &mdash; make it active</button>
          </div>
          {profile.setup_status === 'active' ? <Pill tone="good">Active</Pill> : null}
        </Card>
      ) : null}
    </div>
  )
}
