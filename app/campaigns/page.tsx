import Link from 'next/link'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db'
import { BUTTON, BUTTON_PRIMARY, PageShell, DbNotConnected } from '@/components/app/PageShell'
import { Card, EmptyNote, Pill, SectionHeader } from '@/components/dashboard/primitives'
import { shortDate } from '@/components/leads/pills'
import { listCampaigns, listStatuses } from '@/lib/campaigns/store'
import { listPools } from '@/lib/pools/store'
import { POOL_SLUG_RE } from '@/lib/campaigns/types'
import { INPUT, LABEL, Notice } from '@/components/campaigns/ui'
import { currentRole } from '@/lib/auth/session'
import { canAtLeast } from '@/lib/auth/roles'
import { addStatusAction, archiveCampaignAction, createCampaignAction, toggleStatusAction } from '@/app/actions/campaigns'
import { GoalPicker } from '@/components/campaigns/GoalPicker'
import { listRecipes } from '@/lib/journeys/recipes'
import { GOALS } from '@/lib/journeys/goals'

export const dynamic = 'force-dynamic'

type SP = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''

/**
 * Campaigns workspace: every campaign in the lead database, whether or not it
 * ever reaches Instantly. The Instantly numbers live at /campaigns/performance
 * (old /campaigns?range=… links are sent there).
 */
export default async function CampaignsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams
  if (sp.range !== undefined) redirect(`/campaigns/performance?range=${encodeURIComponent(one(sp.range))}`)
  const db = getDb()
  const perfLink = (
    <Link className={BUTTON} href="/campaigns/performance" prefetch={false}>
      Instantly performance
    </Link>
  )
  if (!db) {
    return (
      <PageShell title="Campaigns" actions={perfLink}>
        <DbNotConnected what="The campaigns workspace" />
      </PageShell>
    )
  }
  // Viewers get no edit controls (#97 view-only rule); every action below also
  // refuses them server-side via actorFor('editor').
  const canEdit = canAtLeast(await currentRole(), 'editor')
  const showArchived = one(sp.archived) === '1'
  const pools = await listPools(db)
  const poolLabel: Record<string, string> = Object.fromEntries(pools.map((p) => [p.id, p.label]))
  const pool = POOL_SLUG_RE.test(one(sp.pool)) && pools.some((p) => p.id === one(sp.pool)) ? one(sp.pool) : null
  const [campaigns, statuses, allStatuses] = await Promise.all([
    listCampaigns(db, { includeArchived: showArchived, pool }),
    listStatuses(db),
    listStatuses(db, { includeInactive: true }),
  ])
  const sources = await listCampaigns(db, { includeArchived: false })
  const recipes = await listRecipes(db).catch(() => [])
  const live = campaigns.filter((c) => !c.is_template)
  const templates = campaigns.filter((c) => c.is_template)
  const err = one(sp.error)
  const qs = (patch: Record<string, string | null>) => {
    const u = new URLSearchParams()
    if (showArchived) u.set('archived', '1')
    if (pool) u.set('pool', pool)
    for (const [k, v] of Object.entries(patch)) {
      if (v) u.set(k, v)
      else u.delete(k)
    }
    return `/campaigns${u.size ? `?${u}` : ''}`
  }
  const chip = (on: boolean) => `rounded-full border px-2.5 py-1 text-[12px] ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface text-ink-muted hover:text-ink'}`

  const table = (rows: typeof campaigns, empty: string) =>
    rows.length ? (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-[13px]">
          <thead className="border-b border-line text-[11.5px] uppercase tracking-[0.05em] text-ink-faint">
            <tr>
              <th className="px-4 py-2 font-medium">Campaign</th>
              <th className="px-3 py-2 font-medium">Pool</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 text-right font-medium">Leads</th>
              <th className="px-3 py-2 font-medium">Owner</th>
              <th className="px-3 py-2 font-medium">Updated</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-b border-line-soft last:border-0">
                <td className="px-4 py-2.5">
                  <Link href={`/campaigns/${c.id}`} className="font-medium text-ink hover:text-accent">{c.name}</Link>
                  {c.goal ? <p className="mt-0.5 line-clamp-1 text-[12px] text-ink-faint">{c.goal}</p> : null}
                </td>
                <td className="px-3 py-2.5 text-ink-muted">{poolLabel[c.pool] ?? c.pool}</td>
                <td className="px-3 py-2.5"><Pill tone={c.status === 'active' ? 'good' : c.status_archived ? 'neutral' : c.status === 'paused' ? 'warn' : 'accent'}>{c.status_label}</Pill></td>
                <td className="px-3 py-2.5 text-right tabular-nums">{c.lead_count.toLocaleString('en-US')}</td>
                <td className="px-3 py-2.5 text-ink-muted">{c.owner_name ?? c.owner ?? '—'}</td>
                <td className="px-3 py-2.5 tabular-nums text-ink-faint">{shortDate(c.updated_at)}</td>
                <td className="px-4 py-2.5 text-right">
                  {canEdit && !c.status_archived ? (
                    <form action={archiveCampaignAction} className="inline-flex items-center gap-1.5">
                      <input type="hidden" name="campaign_id" value={c.id} />
                      <input type="hidden" name="return_to" value="/campaigns" />
                      <label className="flex items-center gap-1 text-[11.5px] text-ink-faint">
                        <input type="checkbox" name="confirm" value="yes" required /> sure
                      </label>
                      <button className={BUTTON}>Archive</button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <EmptyNote>{empty}</EmptyNote>
    )

  return (
    <PageShell
      title="Campaigns"
      meta={`${live.length} campaign${live.length === 1 ? '' : 's'}${templates.length ? ` · ${templates.length} template${templates.length === 1 ? '' : 's'}` : ''} · built here; sending through Instantly is a separate step that needs your OK`}
      actions={
        <>
          {canEdit ? (
            <Link className={BUTTON_PRIMARY} href="/campaigns/new" prefetch={false}>
              New campaign
            </Link>
          ) : null}
          {perfLink}
        </>
      }
    >
      {err ? <Notice tone="bad">{err}</Notice> : null}
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-6">
          <div className="flex flex-wrap gap-1.5">
            <Link className={chip(!pool)} href={qs({ pool: null })}>All pools</Link>
            {pools.map((p) => <Link key={p.id} className={chip(pool === p.id)} href={qs({ pool: p.id })}>{p.label}</Link>)}
            <Link className={chip(showArchived)} href={qs({ archived: showArchived ? null : '1' })}>{showArchived ? 'Hide archived' : 'Show archived'}</Link>
          </div>
          <section aria-labelledby="c-h">
            <SectionHeader id="c-h" title="Campaigns" />
            <Card>{table(live, canEdit ? 'No campaigns yet. Start one with the quick-create form.' : 'No campaigns yet.')}</Card>
          </section>
          <section aria-labelledby="t-h">
            <SectionHeader id="t-h" title="Templates" meta="Start a new campaign from one: settings and leads are copied" />
            <Card>{table(templates, 'No templates yet. Any campaign can be saved as a template from its page.')}</Card>
          </section>
        </div>

        <aside className="space-y-5">
          {canEdit ? (
          <section aria-labelledby="new-h">
            <SectionHeader id="new-h" title="Quick create" />
            <Card className="p-3">
              <form action={createCampaignAction} className="space-y-3">
                <label className={LABEL}>Name<input name="name" required maxLength={120} className={INPUT} placeholder="e.g. Maryland jewelers, fall" /></label>
                <label className={LABEL}>Pool
                  <select name="pool" className={INPUT} defaultValue={pools[0]?.id ?? 'jeweler'}>
                    {pools.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                </label>
                <GoalPicker />
                <label className={LABEL}>Start from
                  <select name="from_id" className={INPUT} defaultValue="">
                    <option value="">Blank</option>
                    {recipes.map((r) => <option key={r.key} value={`recipe:${r.key}`}>Recipe: {r.name} ({GOALS.find((g) => g.key === r.goal_key)?.label ?? r.goal_key})</option>)}
                    {sources.map((c) => <option key={c.id} value={c.id}>{c.is_template ? 'Template: ' : 'Copy of: '}{c.name}</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-2 text-[12px] text-ink-muted"><input type="checkbox" name="with_leads" defaultChecked /> When copying, copy its leads too</label>
                <button className={BUTTON_PRIMARY}>Create</button>
              </form>
            </Card>
          </section>
          ) : null}

          <section aria-labelledby="st-h">
            <SectionHeader id="st-h" title="Statuses" meta="Your list, not fixed" />
            <Card className="divide-y divide-line-soft">
              {allStatuses.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-2 px-3 py-2 text-[13px]">
                  <span className={s.active ? 'text-ink' : 'text-ink-faint line-through'}>
                    {s.label} <span className="text-[11.5px] text-ink-faint">{s.id}{s.is_archived ? ' · archived' : ''}</span>
                  </span>
                  {canEdit && s.id !== 'draft' && s.id !== 'archived' ? (
                    <form action={toggleStatusAction}>
                      <input type="hidden" name="id" value={s.id} />
                      <input type="hidden" name="active" value={s.active ? 'no' : 'yes'} />
                      <button className={BUTTON}>{s.active ? 'Turn off' : 'Turn on'}</button>
                    </form>
                  ) : null}
                </div>
              ))}
              {canEdit ? (
              <form action={addStatusAction} className="flex flex-wrap items-end gap-2 p-3">
                <label className={LABEL}>Id<input name="id" required pattern="[a-z][a-z0-9_]{0,30}" className={`${INPUT} w-24`} placeholder="warming" /></label>
                <label className={LABEL}>Label<input name="label" required maxLength={40} className={`${INPUT} w-28`} placeholder="Warming up" /></label>
                <label className="flex items-center gap-1 pb-2 text-[11.5px] text-ink-faint"><input type="checkbox" name="is_archived" /> archived</label>
                <button className={BUTTON}>Add</button>
              </form>
              ) : null}
            </Card>
            <p className="mt-2 text-[11.5px] text-ink-faint">{statuses.length} statuses can be picked.</p>
          </section>
        </aside>
      </div>
    </PageShell>
  )
}
