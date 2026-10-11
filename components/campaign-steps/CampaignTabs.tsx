import Link from 'next/link'

/** The tabs of one campaign: its leads and settings (/campaigns/:id), its email steps (/campaigns/:id/steps), and its profile (/campaigns/:id/profile). */
export function CampaignTabs({ campaignId, active }: { campaignId: number; active: 'leads' | 'steps' | 'profile' }) {
  const tabs = [
    { key: 'leads', label: 'Leads & settings', href: `/campaigns/${campaignId}` },
    { key: 'steps', label: 'Steps', href: `/campaigns/${campaignId}/steps` },
    { key: 'profile', label: 'Profile', href: `/campaigns/${campaignId}/profile` },
  ] as const
  return (
    <nav aria-label="Campaign sections" className="mb-5 flex gap-1 border-b border-line">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          prefetch={false}
          aria-current={t.key === active ? 'page' : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-[13px] ${
            t.key === active ? 'border-accent font-medium text-ink' : 'border-transparent text-ink-muted hover:text-ink'
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  )
}
