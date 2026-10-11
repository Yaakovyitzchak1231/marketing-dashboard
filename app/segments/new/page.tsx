import { getDb } from '@/lib/db'
import { PageFrame, DbNotConnected } from '@/components/ops/bits'
import { EmptyNote } from '@/components/dashboard/primitives'
import { allFields } from '@/lib/segments/fields'
import { listCampaigns } from '@/lib/campaigns/store'
import { isSegmentAiConfigured } from '@/lib/segments/ai'
import { SegmentBuilder } from '@/components/segments/SegmentBuilder'
import { isUndefinedTable } from '@/lib/db/errors'

export const dynamic = 'force-dynamic'

/** Only SQLSTATE 42P01 (table not migrated yet); a missing column/function is a real error and is rethrown. */
function isMissingTable(e: unknown): boolean {
  return isUndefinedTable(e)
}

export default async function NewSegmentPage() {
  const db = getDb()
  if (!db) {
    return (
      <PageFrame title="New segment">
        <DbNotConnected what="Segments" />
      </PageFrame>
    )
  }
  let campaigns: Awaited<ReturnType<typeof listCampaigns>> = []
  try {
    campaigns = await listCampaigns(db, {})
  } catch (e) {
    if (isMissingTable(e)) {
      return (
        <PageFrame title="New segment">
          <EmptyNote>Needs migration 0024 — it runs on the next production deploy.</EmptyNote>
        </PageFrame>
      )
    }
    throw e
  }
  const aiConfigured = await isSegmentAiConfigured()
  return (
    <PageFrame title="New segment" meta="Pick conditions, or describe it in plain English below.">
      <SegmentBuilder
        mode="new"
        fields={allFields()}
        campaigns={campaigns.map((c) => ({ id: c.id, name: c.name }))}
        aiConfigured={aiConfigured}
        initial={{ name: '', description: '', entity: 'company', campaignId: null, definition: { entity: 'company', include: [], exclude: [] } }}
      />
    </PageFrame>
  )
}
