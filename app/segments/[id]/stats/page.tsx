import { getDb } from '@/lib/db'
import { getSegment } from '@/lib/segments/store'
import { segmentStats } from '@/lib/segments/stats'
import { SegmentStats } from '@/components/segments/SegmentStats'
import { Card } from '@/components/dashboard/primitives'

export const dynamic = 'force-dynamic'

export default async function SegmentStatsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const segId = Number(id)
  const db = getDb()

  if (!db) {
    return (
      <main className="mx-auto max-w-shell px-4 py-6 sm:px-6">
        <h1 className="text-[15px] font-semibold text-ink">Segment stats</h1>
        <p className="mt-2 text-[13px] text-ink-faint">The lead database is not connected (DATABASE_URL is not set).</p>
      </main>
    )
  }

  if (!Number.isInteger(segId) || segId <= 0) {
    return (
      <main className="mx-auto max-w-shell px-4 py-6 sm:px-6">
        <p className="text-[13px] text-ink-faint">Not a valid segment id.</p>
      </main>
    )
  }

  let notice: string | null = null
  let seg: Awaited<ReturnType<typeof getSegment>> = null
  let data: Awaited<ReturnType<typeof segmentStats>> | null = null
  try {
    seg = await getSegment(db, segId)
    if (seg) data = await segmentStats(db, seg)
  } catch (e) {
    if (/does not exist/i.test((e as Error).message ?? '')) notice = 'Needs migration 0033 — it runs on the next production deploy.'
    else throw e
  }

  return (
    <main className="mx-auto max-w-shell px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">{seg ? `${seg.name} — stats` : 'Segment stats'}</h1>
        <p className="mt-1 text-[13px] text-ink-faint">Size over time, reply rate and meetings for this segment.</p>
      </header>
      {notice ? (
        <Card className="p-4"><p className="text-[13px] text-ink-faint">{notice}</p></Card>
      ) : !seg ? (
        <Card className="p-4"><p className="text-[13px] text-ink-faint">No segment #{segId}.</p></Card>
      ) : data ? (
        <SegmentStats data={data} entity={seg.entity} />
      ) : null}
    </main>
  )
}
