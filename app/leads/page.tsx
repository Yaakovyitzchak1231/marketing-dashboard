import Link from 'next/link'
import { getDb } from '@/lib/db'
import { PageShell, DbNotConnected } from '@/components/app/PageShell'
import { Card, EmptyNote } from '@/components/dashboard/primitives'
import { parseLeadQuery, leadsHref, defaultDir, SORT_KEYS, VIEW_LABELS, NONE, activeFilterCount, parseSegParam, decodeAdvancedFilter } from '@/lib/leads/filters'
import { listLeads, kanbanLeads, campaignGroups, regionGroups, leadFacets } from '@/lib/leads/queries'
import { leadScoreChips } from '@/lib/scoring/engine'
import { resolveAdvancedFilter } from '@/lib/leads/advanced'
import { listPools } from '@/lib/pools/store'
import { LeadsTable, type SortLink } from '@/components/leads/LeadsTable'
import { ViewTabs, FilterBar, Pagination, KanbanBoard, CampaignGroups, RegionGroups } from '@/components/leads/LeadViews'
import { FilterDrawer } from '@/components/leads/FilterDrawer'
import { shortDate } from '@/components/leads/pills'
import { VerifyButton } from '@/components/verify/VerifyButton'
import { BUTTON, BUTTON_PRIMARY } from '@/components/app/PageShell'

export const dynamic = 'force-dynamic'

const VIEW_NOTES = {
  table: null,
  kanban: 'Newest 25 per stage. Change a card’s stage with its menu.',
  campaign: 'Grouped by the latest Instantly campaign each lead was in.',
  region: 'Click a state or a number to see those leads.',
  research: 'Leads that still need research, or whose research failed.',
  verify: 'Leads with at least one email nobody has verified yet.',
} as const

export default async function LeadsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const q = parseLeadQuery(sp)
  const db = getDb()
  if (!db) {
    return (
      <PageShell title="Leads">
        <DbNotConnected what="The Leads screen" />
      </PageShell>
    )
  }
  // Advanced filters (plan 2.5): ?seg=<id> (a saved segment) or ?f=<encoded
  // definition> (Standard/Behaviour rows), resolved to exact company ids and
  // intersected with every other filter below. Neither rides the LeadFilters
  // URL contract -- an old /leads URL with neither param behaves exactly as
  // before.
  const segId = parseSegParam(sp.seg)
  const adHocDef = decodeAdvancedFilter(sp.f)
  const adv = await resolveAdvancedFilter(db, segId, adHocDef)
  const effectiveFilters = { ...q.filters, companyIds: adv.companyIds }
  const qEff = { ...q, filters: effectiveFilters }
  const adHocRowCount = adHocDef ? adHocDef.include.reduce((n, g) => n + g.conditions.length, 0) : 0

  const [facets, pools] = await Promise.all([leadFacets(db), listPools(db)])
  const filtered = activeFilterCount(q.filters) > 0 || adv.companyIds !== null
  const note = VIEW_NOTES[q.view]

  let body: React.ReactNode
  let meta: string
  let matchingTotal: number | null = null
  if (q.view === 'kanban') {
    const cols = await kanbanLeads(db, effectiveFilters)
    const n = cols.reduce((s, c) => s + c.count, 0)
    matchingTotal = n
    meta = `${n.toLocaleString('en-US')} ${filtered ? 'matching ' : ''}leads by stage`
    body = <KanbanBoard q={q} columns={cols} />
  } else if (q.view === 'campaign') {
    const groups = await campaignGroups(db, effectiveFilters)
    meta = `${groups.filter((g) => g.key !== null).length} campaigns`
    body = <CampaignGroups q={q} groups={groups} />
  } else if (q.view === 'region') {
    const groups = await regionGroups(db, effectiveFilters)
    meta = `${groups.filter((g) => g.key !== null).length} states`
    body = <RegionGroups q={q} groups={groups} />
  } else {
    const page = await listLeads(db, qEff)
    const chips = await leadScoreChips(db, page.rows.map((r) => r.id))
    for (const r of page.rows) {
      const c = chips.get(r.id)
      r.score = c?.score ?? null
      r.score_model = c?.model_name ?? null
      r.score_threshold = c?.threshold_label ?? null
    }
    matchingTotal = page.total
    meta = `${page.total.toLocaleString('en-US')} ${filtered || q.view !== 'table' ? 'matching ' : ''}lead${page.total === 1 ? '' : 's'}`
    const sortLinks: SortLink[] = SORT_KEYS.map((k) => {
      const current = q.sort === k
      const dir = current ? (q.dir === 'asc' ? 'desc' : 'asc') : defaultDir(k)
      return { key: k, href: leadsHref(q, { sort: k, dir }), dir: current ? q.dir : undefined }
    })
    const updatedLabels = Object.fromEntries(page.rows.map((r) => [r.id, shortDate(r.updated_at)]))
    body = page.rows.length ? (
      <>
        <LeadsTable rows={page.rows} sortLinks={sortLinks} updatedLabels={updatedLabels} showResearch={q.view === 'research'} />
        <Pagination q={q} page={page} />
      </>
    ) : (
      <Card>
        <EmptyNote>
          {facets.total === 0
            ? 'No leads in the database yet. Import the Lead Master sheet or run Find leads.'
            : adv.companyIds !== null && adv.companyIds.length === 0
              ? 'No leads match that segment.'
              : 'No leads match these filters.'}
        </EmptyNote>
      </Card>
    )
  }

  return (
    <PageShell
      title="Leads"
      meta={filtered || q.view !== 'table' ? `${meta} · ${facets.total.toLocaleString('en-US')} in the database` : meta}
      actions={
<>
          <Link href="/leads/duplicates" prefetch={false} className="text-[12px] text-ink-faint hover:text-ink">
            Find duplicates
          </Link>
          <Link href="/leads/import" className={BUTTON}>
            Import CSV
          </Link>
          <Link href="/leads/add" className={BUTTON_PRIMARY}>
            Add lead
          </Link>
        </>
      }
    >
      <ViewTabs q={q} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <FilterBar q={q} states={facets.states} campaigns={facets.campaigns} segments={pools} />
        <FilterDrawer
          activeSegId={adv.source?.kind === 'segment' ? adv.source.id : null}
          activeHasAdHoc={adv.source?.kind === 'ad_hoc'}
          activeRowCount={adHocRowCount}
          matching={matchingTotal}
        />
      </div>
      {adv.source?.kind === 'segment' ? (
        <p className="mb-3 text-[12px] text-ink-faint">
          Filtered by segment “{adv.source.name}”.
        </p>
      ) : null}
      {note ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[12px] text-ink-faint">
            {VIEW_LABELS[q.view]}: {note}
          </p>
          {q.view === 'verify' ? (
            // The verify screen's selector takes state/stage/segment/q; has-email, owner, job and campaign don't carry over.
            <VerifyButton
              label="Verify all matching"
              filter={{
                state: q.filters.state && q.filters.state !== NONE ? q.filters.state : null,
                stage: q.filters.stage ?? null,
                segment: q.filters.segment ?? null,
                q: q.filters.q ?? null,
                verification_status: 'unverified',
              }}
            />
          ) : null}
        </div>
      ) : null}
      {body}
    </PageShell>
  )
}
