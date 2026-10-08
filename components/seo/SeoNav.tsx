'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

export const SEO_TABS = [
  { href: '/seo', label: 'Overview' },
  { href: '/seo/sites', label: 'Sites' },
  { href: '/seo/audit', label: 'Technical audit' },
  { href: '/seo/visibility', label: 'AI visibility' },
  { href: '/seo/todos', label: 'Fix list' },
  { href: '/seo/search-console', label: 'Search Console' },
] as const

export function SeoNav() {
  const pathname = usePathname() ?? '/seo'
  return (
    <nav aria-label="SEO sections" className="-mx-4 mb-5 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
      <ul className="flex gap-1.5">
        {SEO_TABS.map((t) => {
          const active = t.href === '/seo' ? pathname === '/seo' : pathname === t.href || pathname.startsWith(`${t.href}/`)
          return (
            <li key={t.href} className="shrink-0">
              <Link
                href={t.href}
                prefetch={false}
                aria-current={active ? 'page' : undefined}
                className={`block whitespace-nowrap rounded-card border px-2.5 py-1 text-[12px] ${
                  active ? 'border-ink bg-ink text-white' : 'border-line bg-surface text-ink-muted hover:text-ink'
                }`}
              >
                {t.label}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
