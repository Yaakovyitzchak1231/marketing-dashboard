import Link from 'next/link'
import { getDb } from '@/lib/db'
import { PageShell, DbNotConnected } from '@/components/app/PageShell'
import { NewCampaignForm } from '@/components/campaigns/NewCampaignForm'
import { listCampaigns } from '@/lib/campaigns/store'
import { listPools } from '@/lib/pools/store'
import { currentRole } from '@/lib/auth/session'
import { canAtLeast } from '@/lib/auth/roles'
import { createCampaignAction } from '@/app/actions/campaigns'

export const dynamic = 'force-dynamic'

type SP = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? ''

/** Guided new campaign: step 1 creates it (same action and Editor gate as /campaigns), step 2 is its Profile wizard. */
export default async function NewCampaignPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams
  const meta = (
    <Link href="/campaigns" className="underline decoration-line underline-offset-2 hover:text-ink">Campaigns</Link>
  )
  const db = getDb()
  if (!db) {
    return (
      <PageShell title="New campaign" meta={meta}>
        <DbNotConnected what="The campaigns workspace" />
      </PageShell>
    )
  }
  // Fail closed: a missing or unknown role gets no edit access (Kilo review).
  const canEdit = canAtLeast(await currentRole(), 'editor')
  const [pools, sources] = canEdit ? await Promise.all([listPools(db), listCampaigns(db, { includeArchived: false })]) : [[], []]
  return (
    <PageShell title="New campaign" meta={meta}>
      <NewCampaignForm canEdit={canEdit} pools={pools} sources={sources} error={one(sp.error) || undefined} action={createCampaignAction} />
    </PageShell>
  )
}
