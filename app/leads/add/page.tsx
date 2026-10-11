import { getDb } from '@/lib/db'
import { PageShell, DbNotConnected } from '@/components/app/PageShell'
import { Card, SectionHeader } from '@/components/dashboard/primitives'
import { listPools } from '@/lib/pools/store'
import { listCampaigns } from '@/lib/campaigns/store'
import { AddLeadForm } from '@/components/leads/AddLeadForm'
import { addLeadAction } from '@/app/actions/leads-import'

export const dynamic = 'force-dynamic'

export default async function AddLeadPage() {
  const db = getDb()
  if (!db) {
    return (
      <PageShell title="Add lead">
        <DbNotConnected what="Add lead" />
      </PageShell>
    )
  }
  const [pools, campaigns] = await Promise.all([listPools(db), listCampaigns(db)])
  return (
    <PageShell title="Add lead" meta="One company and contact, by hand. Phone-only is fine -- email isn't required.">
      <section className="mb-6">
        <SectionHeader title="Lead" />
        <Card className="p-4">
          <AddLeadForm action={addLeadAction} pools={pools.map((p) => ({ id: p.id, label: p.label }))} campaigns={campaigns.map((c) => ({ id: c.id, name: c.name }))} />
        </Card>
      </section>
    </PageShell>
  )
}
