import { Card } from '@/components/dashboard/primitives'
import type { SetupItem } from '@/lib/settings/needs-setup'

/** The "what do I still need to do" box at the top of /settings: a count and a jump link to every field that is not set. */
export function NeedsSetup({ items }: { items: SetupItem[] }) {
  const required = items.filter((i) => !i.optional)
  const optional = items.filter((i) => i.optional)
  if (!required.length) {
    return (
      <Card className="mb-6 border-good/40 p-4">
        <p className="text-[13px] font-semibold text-good">Everything is set up.</p>
        {optional.length ? <p className="mt-1 text-[12.5px] text-ink-muted">Optional, not set: {optional.map((i) => i.label).join(', ')}.</p> : null}
      </Card>
    )
  }
  const groups: { group: string; items: SetupItem[] }[] = []
  for (const i of required) {
    const g = groups.find((x) => x.group === i.group)
    if (g) g.items.push(i)
    else groups.push({ group: i.group, items: [i] })
  }
  return (
    <Card className="mb-6 border-warn/40 p-4">
      <p className="text-[13px] font-semibold text-warn">
        {required.length} {required.length === 1 ? 'thing needs' : 'things need'} setup
      </p>
      <p className="mt-0.5 text-[12px] text-ink-faint">Tap one to jump to it. Each is marked “Not set” below.</p>
      <ul className="mt-2 space-y-1">
        {groups.map((g) => (
          <li key={g.group} className="text-[12.5px] leading-snug">
            <span className="text-ink-muted">{g.group}: </span>
            {g.items.map((i, n) => (
              <span key={i.key}>
                {n ? ', ' : ''}
                <a href={`#${i.anchor}`} className="text-accent underline-offset-2 hover:underline">
                  {i.label}
                </a>
              </span>
            ))}
          </li>
        ))}
      </ul>
      {optional.length ? <p className="mt-2 text-[12px] text-ink-faint">Optional: {optional.map((i) => i.label).join(', ')}.</p> : null}
    </Card>
  )
}
