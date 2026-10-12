import Link from 'next/link'
import { getDb } from '@/lib/db'
import { DbNotConnected, PageShell } from '@/components/app/PageShell'
import { EmptyNote } from '@/components/dashboard/primitives'
import { StepsEditor } from '@/components/campaign-steps/StepsEditor'
import { ExperimentsPanel } from '@/components/campaign-steps/ExperimentsPanel'
import { CampaignTabs } from '@/components/campaign-steps/CampaignTabs'
import { stepsOverview } from '@/lib/campaign-steps/http'
import { loadCampaignLeads } from '@/lib/campaign-steps/adapter'
import { StepsError } from '@/lib/campaign-steps/store'

export const dynamic = 'force-dynamic'

/** The Steps tab of a campaign: /campaigns/:id/steps. */
export default async function CampaignStepsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const db = getDb()
  if (!db) {
    return (
      <PageShell title="Campaign steps">
        <DbNotConnected what="Campaign steps" />
      </PageShell>
    )
  }
  const campaignId = /^\d{1,15}$/.test(id) ? Number(id) : 0
  let data: Awaited<ReturnType<typeof stepsOverview>> | null = null
  try {
    if (campaignId) data = await stepsOverview(db, campaignId)
  } catch (e) {
    if (!(e instanceof StepsError)) throw e
  }
  if (!data) {
    return (
      <PageShell title="Campaign steps">
        <EmptyNote>No campaign with that id.</EmptyNote>
      </PageShell>
    )
  }
  const leads = await loadCampaignLeads(db, campaignId)
  const stepNumbers = [...new Set(data.steps.map((s) => s.step_number))].sort((a, b) => a - b)
  return (
    <PageShell
      title={`${data.campaign.name}: steps`}
      meta={
        <>
          <Link href={`/campaigns/${campaignId}`} className="underline decoration-line underline-offset-2 hover:text-ink">
            Campaign
          </Link>{' '}
          · Steps
        </>
      }
    >
      <CampaignTabs campaignId={campaignId} active="steps" />
      <StepsEditor
        campaign={data.campaign}
        steps={data.steps}
        fields={data.fields}
        fieldsFrom={data.fields_from}
        pushRequests={data.push_requests}
        leads={leads.map((l) => ({ company_id: l.company_id, company_name: l.company_name, email: l.email }))}
      />
      <ExperimentsPanel campaignId={campaignId} stepNumbers={stepNumbers} />
    </PageShell>
  )
}
