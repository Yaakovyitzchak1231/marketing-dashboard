import Link from 'next/link'
import type { KanbanColumn, LeadGroup, LeadPage } from '@/lib/leads/queries'
import { LEAD_VIEWS, VIEW_LABELS, NONE, STAGE_LABELS, leadsHref, activeFilterCount, type LeadQuery } from '@/lib/leads/filters'
import { STAGES, VERIFICATION_STATUSES, type Stage } from '@/lib/leads/types'
import { Card, EmptyNote } from '@/components/dashboard/primitives'
import { BUTTON } from '@/components/app/PageShell'
import { VerificationPill, place } from './pills'
import { StageSelect } from './StageSelect'

const fmt = (n: number) => n.toLocaleString('en-US')

export function ViewTabs({ q }: { q: LeadQuery }) {
  return (
    <nav aria-label="Lead views" className="-mx-4 mb-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
      <ul className="flex w-max gap-1 rounded-card border border-line bg-surface p-0.5">
        {LEAD_VIEWS.map((v) => {
          const active = q.view === v
          return (
            <li key={v}>
              <Link
                href={leadsHref(q, { view: v })}
                prefetch={false}
                aria-current={active ? 'page' : undefined}
                className={`block whitespace-nowrap rounded-[3px] px-2.5 py-1.5 text-xs font-medium ${
                  active ? 'bg-accent text-white' : 'text-ink-muted hover:bg-canvas hover:text-ink'
                }`}
              >
                {VIEW_LABELS[v]}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

const SELECT = 'w-full rounded-control border border-line bg-surface px-2 py-1.5 text-xs text-ink sm:w-auto sm:max-w-[200px]'

/** Plain GET form: works without JavaScript, every filter lives in the URL. */
export function FilterBar({ q, states, campaigns, segments = [] }: { q: LeadQuery; states: string[]; campaigns: string[]; segments?: { id: string; label: string }[] }) {
  const f = q.filters
  const yn = (v: boolean | undefined) => (v === undefined ? '' : v ? 'yes' : 'no')
  // Filters beyond search and the job link, so an active filter keeps the panel open.
  const narrowing = activeFilterCount({ ...f, q: undefined, job: undefined })
  return (
    <form method="get" action="/leads" className="mb-4 rounded-card border border-line bg-surface p-3 shadow-card" role="search">
      {q.view !== 'table' ? <input type="hidden" name="view" value={q.view} /> : null}
      {f.job !== undefined ? <input type="hidden" name="job" value={f.job} /> : null}
      {q.sort !== 'updated' ? <input type="hidden" name="sort" value={q.sort} /> : null}
      <div className="flex gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Search</span>
          <input
            type="search"
            name="q"
            defaultValue={f.q ?? ''}
            placeholder="Search name, site, email, city"
            className="w-full rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-faint"
          />
        </label>
        <button type="submit" className={BUTTON}>
          Search
        </button>
      </div>
      <details className="group mt-2" open={narrowing > 0}>
        <summary className="cursor-pointer select-none list-none text-xs font-medium text-ink-muted hover:text-ink [&::-webkit-details-marker]:hidden">
          <span className="group-open:hidden">Filters{narrowing ? ` (${narrowing})` : ''} ▸</span>
          <span className="hidden group-open:inline">Filters{narrowing ? ` (${narrowing})` : ''} ▾</span>
        </summary>
        <div className="mt-2 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center">
          <Sel name="state" label="State" value={f.state} options={[[NONE, 'No state'], ...states.map((s) => [s, s] as [string, string])]} />
          <Sel name="stage" label="Stage" value={f.stage} options={STAGES.map((s) => [s, STAGE_LABELS[s]])} />
          <Sel name="segment" label="Pool" value={f.segment} options={segments.map((s) => [s.id, s.label])} />
          <Sel
            name="verification"
            label="Email status"
            value={f.verification}
            options={VERIFICATION_STATUSES.map((s) => [s, s === 'catch_all' ? 'Catch-all' : s[0].toUpperCase() + s.slice(1)])}
          />
          <Sel name="email" label="Has email" value={yn(f.hasEmail)} options={[['yes', 'Has email'], ['no', 'No email']]} />
          <Sel name="owner" label="Owner name" value={yn(f.ownerKnown)} options={[['yes', 'Owner known'], ['no', 'Owner unknown']]} />
          <Sel name="ready" label="Ready to send" value={yn(f.ready)} options={[['yes', 'Ready to send'], ['no', 'Not ready']]} />
          <Sel name="touched" label="Instantly activity" value={yn(f.touched)} options={[['yes', 'Has activity'], ['no', 'No activity']]} />
          {campaigns.length || f.campaign ? (
            <Sel
              name="campaign"
              label="Campaign"
              value={f.campaign}
              options={[[NONE, 'No campaign'], ...campaigns.map((c) => [c, c] as [string, string]), ...(f.campaign && f.campaign !== NONE && !campaigns.includes(f.campaign) ? [[f.campaign, f.campaign] as [string, string]] : [])]}
            />
          ) : null}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <button type="submit" className={BUTTON}>
            Apply filters
          </button>
          <Link href={leadsHref({ ...q, filters: {} }, { sort: 'updated', dir: 'desc' })} prefetch={false} className="text-xs text-ink-faint hover:text-ink">
            Clear all
          </Link>
        </div>
      </details>
      {f.job !== undefined ? (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs text-ink-muted">
            From Find-leads job #{f.job} ·{' '}
            <Link className="text-accent" href={leadsHref(q, { filters: { job: undefined } })} prefetch={false}>
              show all
            </Link>
          </span>
        </div>
      ) : null}
    </form>
  )
}

function Sel({ name, label, value, options }: { name: string; label: string; value: string | undefined; options: [string, string][] }) {
  return (
    <label className="min-w-0">
      <span className="sr-only">{label}</span>
      <select name={name} defaultValue={value ?? ''} className={SELECT} aria-label={label}>
        <option value="">{label}: any</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  )
}

export function Pagination({ q, page }: { q: LeadQuery; page: LeadPage }) {
  if (page.total === 0) return null
  const from = (page.page - 1) * page.pageSize + 1
  const to = Math.min(page.total, page.page * page.pageSize)
  return (
    <div className="mt-3 flex items-center justify-between gap-3 text-xs text-ink-muted">
      <span className="tabular-nums" data-testid="page-range">
        {fmt(from)}–{fmt(to)} of {fmt(page.total)}
      </span>
      <span className="flex items-center gap-1">
        {page.page > 1 ? (
          <Link className={BUTTON} href={leadsHref(q, { page: page.page - 1 })} prefetch={false} rel="prev">
            Previous
          </Link>
        ) : null}
        <span className="px-1 tabular-nums text-ink-faint">
          Page {page.page} of {page.pages}
        </span>
        {page.page < page.pages ? (
          <Link className={BUTTON} href={leadsHref(q, { page: page.page + 1 })} prefetch={false} rel="next">
            Next
          </Link>
        ) : null}
      </span>
    </div>
  )
}

export function KanbanBoard({ q, columns }: { q: LeadQuery; columns: KanbanColumn[] }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0" data-testid="kanban">
      <div className="flex w-max gap-3">
        {columns.map((col) => (
          <section key={col.stage} aria-label={col.label} className="flex w-[260px] shrink-0 flex-col rounded-card border border-line bg-canvas/70">
            <header className="flex items-baseline justify-between border-b border-line px-3 py-2">
              <Link href={leadsHref(q, { view: 'table', filters: { stage: col.stage } })} prefetch={false} className="text-xs font-semibold text-ink hover:text-accent">
                {col.label}
              </Link>
              <span className="text-xs tabular-nums text-ink-faint">{fmt(col.count)}</span>
            </header>
            <ul className="flex flex-col gap-2 p-2">
              {col.cards.length === 0 ? <li className="px-1 py-3 text-center text-xs text-ink-faint">Nothing here</li> : null}
              {col.cards.map((c) => (
                <li key={c.id} className="rounded-control border border-line bg-surface px-2.5 py-2 shadow-card">
                  <Link href={`/leads/${c.id}`} prefetch={false} className="block truncate text-sm font-medium text-ink hover:text-accent">
                    {c.name}
                  </Link>
                  <div className="truncate text-2xs text-ink-faint">{place(c.city, c.state) ?? 'No place yet'}</div>
                  <div className="mt-1 truncate text-xs text-ink-muted">{c.primary_email ?? <span className="text-unavailable">No email yet</span>}</div>
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <StageSelect companyId={c.id} stage={c.stage} name={c.name} />
                    {c.primary_verification ? <VerificationPill status={c.primary_verification} /> : null}
                  </div>
                </li>
              ))}
              {col.count > col.cards.length ? (
                <li>
                  <Link
                    href={leadsHref(q, { view: 'table', filters: { stage: col.stage } })}
                    prefetch={false}
                    className="block px-1 py-1 text-center text-xs text-accent"
                  >
                    All {fmt(col.count)} in {col.label}
                  </Link>
                </li>
              ) : null}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}

const STAGE_ORDER = STAGES

function StageBar({ byStage, total }: { byStage: Partial<Record<Stage, number>>; total: number }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-muted">
      {STAGE_ORDER.filter((s) => byStage[s]).map((s) => (
        <span key={s} className="tabular-nums">
          {STAGE_LABELS[s]} <span className="text-ink">{fmt(byStage[s]!)}</span>
        </span>
      ))}
      {total === 0 ? <span>No leads</span> : null}
    </div>
  )
}

export function CampaignGroups({ q, groups }: { q: LeadQuery; groups: LeadGroup[] }) {
  if (!groups.length) return <Card><EmptyNote>No leads match these filters.</EmptyNote></Card>
  return (
    <div className="grid gap-3 md:grid-cols-2" data-testid="campaign-groups">
      {groups.map((g) => (
        <Card key={g.key ?? NONE} className="px-4 py-3">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="min-w-0 truncate text-sm font-semibold text-ink">{g.key ?? 'No campaign yet'}</h3>
            <Link
              href={leadsHref(q, { view: 'table', filters: { campaign: g.key ?? NONE } })}
              prefetch={false}
              className="shrink-0 text-xs tabular-nums text-accent"
            >
              {fmt(g.total)} lead{g.total === 1 ? '' : 's'}
            </Link>
          </div>
          <div className="mt-1.5">
            <StageBar byStage={g.byStage} total={g.total} />
          </div>
          {g.sample.length ? (
            <ul className="mt-2.5 divide-y divide-line-soft border-t border-line-soft">
              {g.sample.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 py-1.5 text-xs">
                  <Link href={`/leads/${r.id}`} prefetch={false} className="min-w-0 truncate text-ink hover:text-accent">
                    {r.name}
                  </Link>
                  <span className="shrink-0 text-ink-faint">{place(r.city, r.state) ?? ''}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ))}
    </div>
  )
}

export function RegionGroups({ q, groups }: { q: LeadQuery; groups: LeadGroup[] }) {
  if (!groups.length) return <Card><EmptyNote>No leads match these filters.</EmptyNote></Card>
  const visible = STAGES.filter((s) => groups.some((g) => g.byStage[s]))
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm" data-testid="region-table">
        <thead className="border-b border-line bg-canvas/60 text-2xs uppercase tracking-[0.05em] text-ink-faint">
          <tr>
            <th className="sticky left-0 bg-canvas px-3 py-2 text-left font-medium">State</th>
            <th className="px-3 py-2 text-right font-medium">Leads</th>
            {visible.map((s) => (
              <th key={s} className="whitespace-nowrap px-3 py-2 text-right font-medium">
                {STAGE_LABELS[s]}
              </th>
            ))}
            <th className="whitespace-nowrap px-3 py-2 text-right font-medium">Unverified emails</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-soft tabular-nums">
          {groups.map((g) => (
            <tr key={g.key ?? NONE} className="hover:bg-canvas/70">
              <td className="sticky left-0 bg-surface px-3 py-2">
                <Link href={leadsHref(q, { view: 'table', filters: { state: g.key ?? NONE } })} prefetch={false} className="font-medium text-ink hover:text-accent">
                  {g.key ?? 'No state'}
                </Link>
              </td>
              <td className="px-3 py-2 text-right text-ink">{fmt(g.total)}</td>
              {visible.map((s) => (
                <td key={s} className="px-3 py-2 text-right text-ink-muted">
                  {g.byStage[s] ? (
                    <Link href={leadsHref(q, { view: 'table', filters: { state: g.key ?? NONE, stage: s } })} prefetch={false} className="hover:text-accent">
                      {fmt(g.byStage[s]!)}
                    </Link>
                  ) : (
                    <span className="text-ink-faint">0</span>
                  )}
                </td>
              ))}
              <td className="px-3 py-2 text-right text-ink-muted">{fmt(g.unverified)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}
