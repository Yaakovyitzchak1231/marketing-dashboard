import Link from 'next/link'
import { getDb } from '@/lib/db'
import { listCampaigns } from '@/lib/campaigns/store'
import { latestMetrics, listIntegrations, type LatestMetric } from '@/lib/integrations/store'
import { DbNotConnected, PageFrame } from '@/components/ops/bits'
import { EmptyNote } from '@/components/dashboard/primitives'
import { LinkCard, ToolCard } from '@/components/tools/ToolCard'
import { ToolForm } from '@/components/tools/ToolForm'
import { DataSourcesSection } from '@/components/sources/DataSourcesSection'
import { sourcesHealth } from '@/lib/sources/health'

export const dynamic = 'force-dynamic'

const DOC_KINDS = new Set(['sheet', 'doc', 'link'])

type SP = Promise<{ campaign?: string; error?: string }>

export default async function ToolsPage({ searchParams }: { searchParams: SP }) {
  const db = getDb()
  if (!db) {
    return (
      <PageFrame title="Tools" meta="Every tool you run, with live health and numbers">
        <DbNotConnected what="The Tools screen" />
      </PageFrame>
    )
  }
  const sp = await searchParams
  const campaignId = Number(sp.campaign) > 0 ? Number(sp.campaign) : null
  const now = new Date()
  const [integrations, metrics, campaigns, sources] = await Promise.all([
    listIntegrations(db, { activeOnly: true }),
    latestMetrics(db, { campaignId }),
    listCampaigns(db, {}),
    sourcesHealth(db),
  ])

  const metricsFor = (id: string): LatestMetric[] => metrics.filter((m) => m.integration_id === id)
  const tools = integrations.filter((i) => !DOC_KINDS.has(i.kind))
  const docs = integrations.filter((i) => DOC_KINDS.has(i.kind))

  const qs = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams()
    const merged = { campaign: sp.campaign ?? null, ...patch }
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v)
    const str = p.toString()
    return str ? `/tools?${str}` : '/tools'
  }
  const chip = (active: boolean) =>
    `rounded-full border px-2.5 py-1 text-[12px] ${active ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface text-ink-muted hover:text-ink'}`

  return (
    <PageFrame title="Tools" meta="Every tool you run, with live health and the numbers your background runner has read">
      {sp.error ? <p className="mb-4 rounded-card border border-bad/30 bg-bad-soft px-3 py-2 text-[12.5px] text-bad">{sp.error}</p> : null}

      {campaigns.length ? (
        <div className="mb-4 flex flex-wrap gap-1.5" aria-label="Filter by campaign">
          <Link className={chip(!campaignId)} href={qs({ campaign: null })}>
            All campaigns
          </Link>
          {campaigns.map((c) => (
            <Link key={c.id} className={chip(campaignId === c.id)} href={qs({ campaign: String(c.id) })}>
              {c.name}
            </Link>
          ))}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {tools.length ? (
              tools.map((integration) => <ToolCard key={integration.id} integration={integration} metrics={metricsFor(integration.id)} now={now} />)
            ) : (
              <EmptyNote>No tools yet — add one on the right.</EmptyNote>
            )}
          </div>

          {docs.length ? (
            <div>
              <h2 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-muted">Docs &amp; sheets</h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {docs.map((integration) => (
                  <LinkCard key={integration.id} integration={integration} />
                ))}
              </div>
            </div>
          ) : null}

          <DataSourcesSection sources={sources} />
        </div>

        <aside>
          <ToolForm />
        </aside>
      </div>
    </PageFrame>
  )
}
