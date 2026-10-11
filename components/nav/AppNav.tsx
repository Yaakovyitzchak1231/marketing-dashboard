'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LiveBell } from '@/components/ops/LiveBell'

/**
 * The app's one navigation bar. Twelve screens, one line: on a phone it scrolls
 * sideways (no hamburger), and the active screen keeps itself in view.
 */
export const NAV_ITEMS = [
  { href: '/', label: 'Overview' },
  { href: '/leads', label: 'Leads' },
  { href: '/find', label: 'Find leads' },
  { href: '/verify', label: 'Verification' },
  { href: '/campaigns', label: 'Campaigns' },
  { href: '/rules', label: 'Lead rules' },
  { href: '/replies', label: 'Replies' },
  { href: '/seo', label: 'SEO / AI' },
  { href: '/team', label: 'Team' },
  { href: '/agents', label: 'Agents' },
  { href: '/activity', label: 'Activity' },
  { href: '/reports', label: 'Reports' },
  { href: '/jobs', label: 'Jobs' },
] as const

export function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function AppNav() {
  const pathname = usePathname() ?? '/'
  if (pathname === '/login') return null
  return (
    <div className="sticky top-0 z-30 print:hidden border-b border-line bg-canvas/95 backdrop-blur supports-[backdrop-filter]:bg-canvas/85">
      <div className="mx-auto flex max-w-shell items-center gap-4 px-4 sm:px-6">
        <Link href="/" prefetch={false} className="hidden shrink-0 text-[13px] font-semibold tracking-[-0.01em] text-ink md:block">
          TapDash
        </Link>
        <nav aria-label="Screens" className="-mx-4 min-w-0 flex-1 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
          <ul className="flex items-stretch gap-0.5">
            {NAV_ITEMS.map((item) => {
              const active = isActive(pathname, item.href)
              return (
                <li key={item.href} className="shrink-0">
                  <Link
                    href={item.href}
                    prefetch={false}
                    aria-current={active ? 'page' : undefined}
                    ref={active ? (el) => el?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }) : undefined}
                    className={`relative block whitespace-nowrap px-2.5 py-3 text-[13px] transition-colors ${
                      active
                        ? 'font-medium text-ink after:absolute after:inset-x-2.5 after:bottom-[-1px] after:h-[2px] after:bg-accent'
                        : 'text-ink-muted hover:text-ink'
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>
        <LiveBell />
      </div>
    </div>
  )
}
