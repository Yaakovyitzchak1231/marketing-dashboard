import Link from 'next/link'

export type ProfileTab = 'overview' | 'timeline' | 'engagement' | 'details'
export const PROFILE_TABS: { key: ProfileTab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'timeline', label: 'Timeline' },
  { key: 'engagement', label: 'Engagement' },
  { key: 'details', label: 'Details' },
]

/** The lead profile's own tabs (plan 2.10): a plain ?tab= query param on the same
 *  route, so every section stays a server-rendered page (no client JS to switch). */
export function ProfileTabs({ companyId, active }: { companyId: number; active: ProfileTab }) {
  return (
    <nav aria-label="Lead profile sections" className="mb-5 flex gap-1 border-b border-line">
      {PROFILE_TABS.map((t) => (
        <Link
          key={t.key}
          href={t.key === 'overview' ? `/leads/${companyId}` : `/leads/${companyId}?tab=${t.key}`}
          prefetch={false}
          aria-current={t.key === active ? 'page' : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${
            t.key === active ? 'border-accent font-medium text-ink' : 'border-transparent text-ink-muted hover:text-ink'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  )
}
