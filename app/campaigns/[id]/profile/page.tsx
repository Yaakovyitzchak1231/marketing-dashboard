import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db'
import { PageShell, DbNotConnected } from '@/components/app/PageShell'
import { CampaignTabs } from '@/components/campaign-steps/CampaignTabs'
import { ProfileWizard } from '@/components/campaign-profiles/ProfileWizard'
import { getCampaign } from '@/lib/campaigns/store'
import { getProfile } from '@/lib/campaign-profiles/store'
import { getAiConfig } from '@/lib/campaign-profiles/suggest'
import { listPools } from '@/lib/pools/store'

export const dynamic = 'force-dynamic'

/** The Profile tab of a campaign: /campaigns/:id/profile. Industry, ICP, keywords, competitors, feeds,
 *  directories, signal rules, fingerprints, UTM and KPIs — the AI-assisted setup wizard. */
export default async function CampaignProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params
  const db = getDb()
  if (!db) {
    return (
      <PageShell title="Campaign profile">
        <DbNotConnected what="The campaign profile" />
      </PageShell>
    )
  }
  if (!/^\d{1,15}$/.test(raw)) notFound()
  const id = Number(raw)
  const campaign = await getCampaign(db, id)
  if (!campaign) notFound()
  const [data, pools] = await Promise.all([getProfile(db, id), listPools(db)])
  return (
    <PageShell
      title={`${campaign.name}: profile`}
      meta={
        <>
          <Link href={`/campaigns/${id}`} className="underline decoration-line underline-offset-2 hover:text-ink">
            Campaign
          </Link>{' '}
          · Profile
        </>
      }
    >
      <CampaignTabs campaignId={id} active="profile" />
      <p className="mb-4 text-[12.5px] text-ink-faint">
        Every monitor, trend chart, lead source and signal this campaign uses reads its setup from here &mdash; nothing is
        hard-coded to one industry. Type the industry below, optionally let AI suggest a starting set, then approve
        what&rsquo;s right.
      </p>
      <ProfileWizard campaignId={id} campaignName={campaign.name} initial={data} pools={pools} aiConfigured={getAiConfig() !== null} />
    </PageShell>
  )
}
