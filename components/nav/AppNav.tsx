'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { LiveBell } from '@/components/ops/LiveBell'

/**
 * The app's one navigation bar.
 *
 * md and up: the busiest screens sit inline and the rest live under "More".
 * Which screens are inline steps up with the width (md, lg, xl), and the More
 * menu holds exactly the ones hidden at the current width, so nothing is ever
 * cut off or out of reach. Below md (phones): brand, current screen, Inbox and
 * a "Menu" button that opens every screen in a grid under the bar.
 */
export const NAV_ITEMS = [
  { href: '/', label: 'Overview' },
  { href: '/leads', label: 'Leads' },
  { href: '/find', label: 'Find leads' },
  { href: '/verify', label: 'Verification' },
  { href: '/campaigns', label: 'Campaigns' },
  { href: '/rules', label: 'Lead rules' },
  { href: '/segments', label: 'Segments' },
  { href: '/suppressions', label: 'Suppressions' },
  { href: '/replies', label: 'Replies' },
  { href: '/seo', label: 'SEO / AI' },
  { href: '/team', label: 'Team' },
  { href: '/agents', label: 'Agents' },
  { href: '/settings', label: 'Settings' },
  { href: '/tools', label: 'Tools' },
  { href: '/activity', label: 'Activity' },
  { href: '/reports', label: 'Reports' },
  { href: '/jobs', label: 'Jobs' },
] as const

type NavHref = (typeof NAV_ITEMS)[number]['href']

/** The smallest width at which a screen sits inline. Missing = always under More. */
type Tier = 'md' | 'lg' | 'xl'
const INLINE_FROM: Partial<Record<NavHref, Tier>> = {
  '/': 'md',
  '/leads': 'md',
  '/find': 'md',
  '/campaigns': 'md',
  '/replies': 'md',
  '/verify': 'lg',
  '/rules': 'lg',
  '/segments': 'lg',
  '/suppressions': 'xl',
  '/seo': 'xl',
}

// Full class strings in static maps so Tailwind sees every one of them.
const INLINE_CLASS: Record<Tier | 'never', string> = {
  md: 'block',
  lg: 'hidden lg:block',
  xl: 'hidden xl:block',
  never: 'hidden',
}
const MORE_CLASS: Record<Tier | 'never', string> = {
  md: 'hidden',
  lg: 'lg:hidden',
  xl: 'xl:hidden',
  never: '',
}

function tierOf(href: NavHref): Tier | 'never' {
  return INLINE_FROM[href] ?? 'never'
}

/** Groups for the phone menu. */
const GROUPS: { title: string; hrefs: NavHref[] }[] = [
  { title: 'Leads', hrefs: ['/', '/leads', '/find', '/verify', '/rules', '/segments', '/suppressions'] },
  { title: 'Outreach', hrefs: ['/campaigns', '/replies', '/seo'] },
  { title: 'Team & admin', hrefs: ['/team', '/agents', '/settings', '/tools', '/activity', '/reports', '/jobs'] },
]
const LABEL: Record<NavHref, string> = Object.fromEntries(NAV_ITEMS.map((i) => [i.href, i.label])) as Record<NavHref, string>

export function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/'
  return pathname === href || pathname.startsWith(`${href}/`)
}

/** Close on Escape (focus back to the button) and on a click/tap outside `box`. */
function useDismiss(open: boolean, close: () => void, box: RefObject<HTMLElement | null>, button: RefObject<HTMLButtonElement | null>) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close()
        button.current?.focus()
      }
    }
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
    }
  }, [open, close, box, button])
}

const UNDERLINE = 'after:absolute after:inset-x-2.5 after:bottom-[-1px] after:h-[2px] after:bg-accent'

export function AppNav() {
  const pathname = usePathname() ?? '/'
  const [moreOpen, setMoreOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const moreBox = useRef<HTMLLIElement>(null)
  const moreButton = useRef<HTMLButtonElement>(null)
  const menuBox = useRef<HTMLDivElement>(null)
  const menuButton = useRef<HTMLButtonElement>(null)

  // Any route change closes both panels (adjusting state during render, not in an effect).
  const [lastPath, setLastPath] = useState(pathname)
  if (lastPath !== pathname) {
    setLastPath(pathname)
    setMoreOpen(false)
    setMenuOpen(false)
  }

  const closeMore = useCallback(() => setMoreOpen(false), [])
  const closeMenu = useCallback(() => setMenuOpen(false), [])
  useDismiss(moreOpen, closeMore, moreBox, moreButton)
  useDismiss(menuOpen, closeMenu, menuBox, menuButton)

  if (pathname === '/login') return null

  const active = NAV_ITEMS.find((i) => isActive(pathname, i.href))
  // Where the active screen sits under More, the More button carries the underline and its name.
  const activeMoreClass = active ? MORE_CLASS[tierOf(active.href)] : 'hidden'
  const activeInMoreAtSomeWidth = active ? tierOf(active.href) !== 'md' : false

  return (
    <div ref={menuBox} className="sticky top-0 z-30 print:hidden border-b border-line bg-canvas/95 backdrop-blur supports-[backdrop-filter]:bg-canvas/85">
      <div className="mx-auto flex max-w-shell items-center gap-2 px-4 sm:px-6 md:gap-4">
        <Link href="/" prefetch={false} className="shrink-0 py-3 text-[13px] font-semibold tracking-[-0.01em] text-ink">
          TapDash
        </Link>
        {active ? (
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink-muted md:hidden" aria-hidden="true">
            <span className="mr-1.5 text-line">/</span>
            {active.label}
          </span>
        ) : (
          <span className="flex-1 md:hidden" />
        )}

        <nav aria-label="Screens" className="hidden min-w-0 flex-1 md:block">
          <ul className="flex items-stretch gap-0.5">
            {NAV_ITEMS.map((item) => {
              const isOn = isActive(pathname, item.href)
              return (
                <li key={item.href} className={`shrink-0 ${INLINE_CLASS[tierOf(item.href)]}`}>
                  <Link
                    href={item.href}
                    prefetch={false}
                    aria-current={isOn ? 'page' : undefined}
                    className={`relative block whitespace-nowrap px-2.5 py-3 text-[13px] transition-colors ${
                      isOn ? `font-medium text-ink ${UNDERLINE}` : 'text-ink-muted hover:text-ink'
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              )
            })}
            <li ref={moreBox} className="relative shrink-0">
              <button
                ref={moreButton}
                type="button"
                aria-haspopup="true"
                aria-expanded={moreOpen}
                aria-controls="nav-more"
                onClick={() => setMoreOpen((o) => !o)}
                className={`relative flex items-center gap-1 whitespace-nowrap px-2.5 py-3 text-[13px] transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
                  moreOpen ? 'text-ink' : 'text-ink-muted'
                }`}
              >
                More
                {active && activeInMoreAtSomeWidth ? (
                  <>
                    {/* The name only where there is room for it (xl, where More holds the short admin names). */}
                    {tierOf(active.href) === 'never' ? <span className="hidden font-medium text-ink xl:inline">· {active.label}</span> : null}
                    <span aria-hidden="true" className={`absolute inset-x-2.5 bottom-[-1px] h-[2px] bg-accent ${activeMoreClass}`} />
                  </>
                ) : null}
                <svg aria-hidden="true" width="10" height="10" viewBox="0 0 10 10" className={`transition-transform ${moreOpen ? 'rotate-180' : ''}`}>
                  <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {moreOpen ? (
                <ul
                  id="nav-more"
                  aria-label="More screens"
                  className="absolute right-0 top-full z-40 mt-1 w-52 rounded-card border border-line bg-surface py-1 shadow-card"
                >
                  {NAV_ITEMS.filter((i) => tierOf(i.href) !== 'md').map((item) => {
                    const isOn = isActive(pathname, item.href)
                    return (
                      <li key={item.href} className={MORE_CLASS[tierOf(item.href)]}>
                        <Link
                          href={item.href}
                          prefetch={false}
                          aria-current={isOn ? 'page' : undefined}
                          onClick={() => setMoreOpen(false)}
                          className={`flex items-center gap-2 px-3 py-2 text-[13px] hover:bg-canvas focus-visible:bg-canvas focus-visible:outline-none ${
                            isOn ? 'font-medium text-ink' : 'text-ink-muted hover:text-ink'
                          }`}
                        >
                          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${isOn ? 'bg-accent' : 'bg-transparent'}`} />
                          {item.label}
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              ) : null}
            </li>
          </ul>
        </nav>

        <LiveBell />

        <button
          ref={menuButton}
          type="button"
          aria-expanded={menuOpen}
          aria-controls="nav-menu"
          onClick={() => setMenuOpen((o) => !o)}
          className="-mr-2 flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 md:hidden"
        >
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14">
            {menuOpen ? (
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            ) : (
              <path d="M2 4h10M2 7h10M2 10h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            )}
          </svg>
          {menuOpen ? 'Close' : 'Menu'}
        </button>
      </div>

      {menuOpen ? (
        <nav
          id="nav-menu"
          aria-label="All screens"
          className="absolute inset-x-0 top-full max-h-[calc(100dvh_-_100%)] overflow-y-auto overscroll-contain border-b border-line bg-canvas px-4 pb-4 pt-2 shadow-card sm:px-6 md:hidden"
        >
          {GROUPS.map((g) => (
            <section key={g.title} className="mt-2">
              <h2 className="px-1 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.06em] text-ink-muted">{g.title}</h2>
              <ul className="grid grid-cols-2 gap-1">
                {g.hrefs.map((href) => {
                  const isOn = isActive(pathname, href)
                  return (
                    <li key={href}>
                      <Link
                        href={href}
                        prefetch={false}
                        aria-current={isOn ? 'page' : undefined}
                        onClick={() => setMenuOpen(false)}
                        className={`flex min-h-[44px] items-center gap-2 rounded-card border bg-surface px-3 text-[14px] ${
                          isOn ? 'border-accent/50 font-medium text-ink' : 'border-line text-ink-muted active:bg-canvas'
                        }`}
                      >
                        <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${isOn ? 'bg-accent' : 'bg-line'}`} />
                        {LABEL[href]}
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </nav>
      ) : null}
    </div>
  )
}
