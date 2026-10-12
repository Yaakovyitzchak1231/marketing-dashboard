import Link from 'next/link'
import { getDb } from '@/lib/db'
import { PageFrame, DbNotConnected, primaryBtnCls } from '@/components/ops/bits'
import { Card, EmptyNote, Pill, SectionHeader } from '@/components/dashboard/primitives'
import { listSegments } from '@/lib/segments/store'
import { compileStoredSegment, countSegment } from '@/lib/segments/compile'
import { readback } from '@/lib/segments/readback'
import { listPresets } from '@/lib/segments/presets'
import { listCampaigns } from '@/lib/campaigns/store'
import { StartFromTemplate } from './StartFromTemplate'
import { isUndefinedTable } from '@/lib/db/errors'

export const dynamic = 'force-dynamic'

const n = (v: number) => v.toLocaleString('en-US')

/** Only SQLSTATE 42P01 (table not migrated yet); a missing column/function is a real error and is rethrown. */
function isMissingTable(e: unknown): boolean {
  return isUndefinedTable(e)
}

export default async function SegmentsPage() {
  const db = getDb()
  if (!db) {
    return (
      <PageFrame title="Segments" meta="Who's in an audience, built from live lead data.">
        <DbNotConnected what="Segments" />
      </PageFrame>
    )
  }

  let segments: Awaited<ReturnType<typeof listSegments>> = []
  let missingMigration = false
  try {
    segments = await listSegments(db, { includeArchived: false })
  } catch (e) {
    if (isMissingTable(e)) missingMigration = true
    else throw e
  }

  if (missingMigration) {
    return (
      <PageFrame title="Segments" meta="Who's in an audience, built from live lead data.">
        <EmptyNote>Needs migration 0024 — it runs on the next production deploy.</EmptyNote>
      </PageFrame>
    )
  }

  const [campaigns, snapshotRows] = await Promise.all([
    listCampaigns(db, {}),
    db.query<{ segment_id: number; companies: number; contacts: number; sendable: number; taken_on: string }>(
      `select distinct on (segment_id) segment_id, companies, contacts, sendable, taken_on
         from lp.segment_snapshots order by segment_id, taken_on desc`,
    ).then((r) => r.rows).catch(() => [] as { segment_id: number; companies: number; contacts: number; sendable: number; taken_on: string }[]),
  ])
  const campaignName = new Map(campaigns.map((c) => [c.id, c.name]))
  const lastSnapshot = new Map(snapshotRows.map((r) => [r.segment_id, r]))

  const rows = await Promise.all(
    segments.map(async (seg) => {
      let counts = { companies: 0, contacts: 0, verified_sendable: 0 }
      try {
        const compiled = await compileStoredSegment(db, seg)
        counts = await countSegment(db, compiled)
      } catch {
        // a segment referencing something since removed (e.g. an archived nested segment) still lists, with 0 counts
      }
      return { seg, counts, readback: readback(seg.definition), snapshot: lastSnapshot.get(seg.id) ?? null }
    }),
  )

  const presets = listPresets()

  return (
    <PageFrame
      title="Segments"
      meta="Who's in an audience, built from live lead data — dynamic (always current) or static (hand-picked)."
      actions={
        <Link href="/segments/new" className={primaryBtnCls}>
          New segment
        </Link>
      }
    >
      <section className="mb-6">
        <SectionHeader title="Start from a template" meta="Creates a normal, fully editable segment." />
        <StartFromTemplate presets={presets} campaigns={campaigns.map((c) => ({ id: c.id, name: c.name }))} />
      </section>

      <section>
        <SectionHeader title="All segments" />
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead className="border-b border-line">
              <tr>
                <th className="px-3 py-2 text-left text-[11.5px] font-semibold uppercase tracking-wide text-ink-faint">Name</th>
                <th className="px-3 py-2 text-left text-[11.5px] font-semibold uppercase tracking-wide text-ink-faint">Campaign</th>
                <th className="px-3 py-2 text-left text-[11.5px] font-semibold uppercase tracking-wide text-ink-faint">Kind</th>
                <th className="px-3 py-2 text-right text-[11.5px] font-semibold uppercase tracking-wide text-ink-faint">Companies</th>
                <th className="px-3 py-2 text-right text-[11.5px] font-semibold uppercase tracking-wide text-ink-faint">Contacts</th>
                <th className="px-3 py-2 text-right text-[11.5px] font-semibold uppercase tracking-wide text-ink-faint">Verified-sendable</th>
                <th className="px-3 py-2 text-left text-[11.5px] font-semibold uppercase tracking-wide text-ink-faint">Last snapshot</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ seg, counts, readback: rb, snapshot }) => (
                <tr key={seg.id} className="border-b border-line last:border-0 align-top">
                  <td className="px-3 py-2">
                    <Link href={`/segments/${seg.id}`} className="font-medium text-ink hover:text-accent">
                      {seg.name}
                    </Link>
                    {seg.is_preset ? <Pill tone="neutral"> template</Pill> : null}
                    <p className="mt-0.5 max-w-[360px] text-[11.5px] text-ink-faint">{rb}</p>
                  </td>
                  <td className="px-3 py-2 text-[12.5px] text-ink-muted">{seg.campaign_id ? (campaignName.get(seg.campaign_id) ?? `#${seg.campaign_id}`) : 'All campaigns'}</td>
                  <td className="px-3 py-2"><Pill tone={seg.kind === 'static' ? 'warn' : 'accent'}>{seg.kind}</Pill></td>
                  <td className="px-3 py-2 text-right text-[12.5px] text-ink">{n(counts.companies)}</td>
                  <td className="px-3 py-2 text-right text-[12.5px] text-ink">{n(counts.contacts)}</td>
                  <td className="px-3 py-2 text-right text-[12.5px] text-ink">{n(counts.verified_sendable)}</td>
                  <td className="px-3 py-2 text-[12px] text-ink-faint">{snapshot ? `${n(snapshot.companies)} / ${n(snapshot.contacts)} on ${new Date(snapshot.taken_on).toLocaleDateString('en-US')}` : 'none yet'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length ? <EmptyNote>No segments yet. Start from a template above, or create one.</EmptyNote> : null}
        </Card>
      </section>
    </PageFrame>
  )
}
