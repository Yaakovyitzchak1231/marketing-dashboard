import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db'
import { PageFrame, DbNotConnected } from '@/components/ops/bits'
import { EmptyNote } from '@/components/dashboard/primitives'
import { allFields } from '@/lib/segments/fields'
import { getSegment } from '@/lib/segments/store'
import { listCampaigns } from '@/lib/campaigns/store'
import { isSegmentAiConfigured } from '@/lib/segments/ai'
import { SegmentBuilder } from '@/components/segments/SegmentBuilder'

export const dynamic = 'force-dynamic'

function isMissingTable(e: unknown): boolean {
  return /does not exist/i.test((e as Error)?.message ?? '')
}

export default async function SegmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const segmentId = Number(id)
  const db = getDb()
  if (!db) {
    return (
      <PageFrame title="Segment">
        <DbNotConnected what="Segments" />
      </PageFrame>
    )
  }
  if (!Number.isInteger(segmentId) || segmentId <= 0) notFound()

  let seg: Awaited<ReturnType<typeof getSegment>> = null
  try {
    seg = await getSegment(db, segmentId)
  } catch (e) {
    if (isMissingTable(e)) {
      return (
        <PageFrame title="Segment">
          <EmptyNote>Needs migration 0024 — it runs on the next production deploy.</EmptyNote>
        </PageFrame>
      )
    }
    throw e
  }
  if (!seg) notFound()

  const [campaigns, aiConfigured] = await Promise.all([listCampaigns(db, {}), isSegmentAiConfigured()])

  return (
    <PageFrame title={seg.name} meta={seg.description ?? undefined}>
      <SegmentBuilder
        mode="edit"
        fields={allFields()}
        campaigns={campaigns.map((c) => ({ id: c.id, name: c.name }))}
        aiConfigured={aiConfigured}
        initial={{
          id: seg.id, name: seg.name, description: seg.description ?? '', entity: seg.entity,
          campaignId: seg.campaign_id, definition: seg.definition, kind: seg.kind,
        }}
      />
    </PageFrame>
  )
}
