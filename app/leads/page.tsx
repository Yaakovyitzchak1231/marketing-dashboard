import { getDb } from '@/lib/db'
import { PageShell, DbNotConnected } from '@/components/app/PageShell'
import { Card, EmptyNote } from '@/components/dashboard/primitives'
import { parseLeadQuery, leadsHref, defaultDir, SORT_KEYS, VIEW_LABELS, NONE, activeFilterCount } from '@/lib/leads/filters'
import { listLeads, kanbanLeads, campaignGroups, regionGroups, leadFacets } from '@/lib/leads/queries'
import { LeadsTable, type SortLink } from '@/components/leads/LeadsTable'
import { ViewTabs, FilterBar, Pagination, KanbanBoard, CampaignGroups, RegionGroups } from '@/components/leads/LeadViews'
import { shortDate } from '@/components/leads/pills'
import { VerifyButton } from '@/components/verify/VerifyButton'

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
  const q = parseLeadQuery(await searchParams)
  const db = getDb()
  if (!db) {
    return (
      <PageShell title="Leads">
        <DbNotConnected what="The Leads screen" />
      </PageShell>
    )
  }
  const facets = await leadFacets(db)
  const filtered = activeFilterCount(q.filters) > 0
  const note = VIEW_NOTES[q.view]

  let body: React.ReactNode
  let meta: string
  if (q.view === 'kanban') {
    const cols = await kanbanLeads(db, q.filters)
    const n = cols.reduce((s, c) => s + c.count, 0)
    meta = `${n.toLocaleString('en-US')} ${filtered ? 'matching ' : ''}leads by stage`
    body = <KanbanBoard q={q} columns={cols} />
  } else if (q.view === 'campaign') {
    const groups = await campaignGroups(db, q.filters)
    meta = `${groups.filter((g) => g.key !== null).length} campaigns`
    body = <CampaignGroups q={q} groups={groups} />
  } else if (q.view === 'region') {
    const groups = await regionGroups(db, q.filters)
    meta = `${groups.filter((g) => g.key !== null).length} states`
    body = <RegionGroups q={q} groups={groups} />
  } else {
    const page = await listLeads(db, q)
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
            : 'No leads match these filters.'}
        </EmptyNote>
      </Card>
    )
  }

  return (
    <PageShell title="Leads" meta={filtered || q.view !== 'table' ? `${meta} · ${facets.total.toLocaleString('en-US')} in the database` : meta}>
      <ViewTabs q={q} />
      <FilterBar q={q} states={facets.states} campaigns={facets.campaigns} />
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
