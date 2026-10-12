import Link from 'next/link'
import { Card, EmptyNote, Pill, SectionHeader } from '@/components/dashboard/primitives'
import type { SegmentsSection } from '@/lib/leads/profile'

/** Segments & Lists card (plan 2.10): which saved segments this lead currently matches
 *  (dynamic, re-checked live) or was hand-added to (static). */
export function SegmentsCard({ data }: { data: SegmentsSection }) {
  return (
    <Card className="p-4">
      <SectionHeader title="Segments & lists" />
      {!data.available ? (
        <EmptyNote>{data.needs_migration}</EmptyNote>
      ) : !data.memberships.length ? (
        <EmptyNote>Not in any segment or list.</EmptyNote>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {data.memberships.map((m) => (
            <li key={m.id} className="min-w-0 max-w-full">
              <Link href={`/segments/${m.id}`} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[12px] text-ink hover:border-accent">
                <span className="min-w-0 [overflow-wrap:anywhere]">{m.name}</span>
                <Pill tone={m.kind === 'static' ? 'neutral' : 'accent'}>{m.kind === 'static' ? 'list' : 'segment'}</Pill>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
