import { Card, Pill, SectionHeader } from '@/components/dashboard/primitives'
import type { ReachabilityItem } from '@/lib/leads/profile'

/** Reachability strip (plan 2.10): verified email, store phone, owner phone, LinkedIn --
 *  each either found (with its value) or "Not found", never invented. */
export function Reachability({ items }: { items: ReachabilityItem[] }) {
  return (
    <Card className="p-4">
      <SectionHeader title="Reachability" />
      <ul className="flex flex-wrap gap-2">
        {items.map((it) => (
          <li key={it.key} className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[12px]">
            <Pill tone={it.ok ? 'good' : 'neutral'}>{it.label}</Pill>
            <span className={it.ok ? 'text-ink' : 'text-ink-faint'}>{it.value ?? 'Not found'}</span>
          </li>
        ))}
      </ul>
    </Card>
  )
}
