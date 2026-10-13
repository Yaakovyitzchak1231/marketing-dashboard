// @vitest-environment jsdom
/**
 * The app shell's navigation (components/shell): the grouped side rail, the
 * phone drawer, the phone bottom bar and the Inbox badge. Replaces the old
 * AppNav top-bar suites (the "More" menu and its label-fitting logic were
 * removed with the rebuild).
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import type { LiveChange } from '@/components/ops/live'

vi.mock('server-only', () => ({}))

const { live, pathname } = vi.hoisted(() => ({
  live: { listeners: new Set<(c: LiveChange) => void>() },
  pathname: { value: '/' },
}))
vi.mock('@/components/ops/live', () => ({
  subscribeLive: (l: (c: LiveChange) => void) => {
    live.listeners.add(l)
    return () => live.listeners.delete(l)
  },
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => pathname.value,
  useSearchParams: () => new URLSearchParams(),
}))

import { AppShell } from '@/components/shell/AppShell'
import { NAV_GROUPS, NAV_ITEMS, BOTTOM_NAV, activeHref, isActive } from '@/components/shell/nav-config'
import * as legacy from '@/components/nav/AppNav'

function pushUnread(unread: number) {
  act(() => {
    for (const l of live.listeners) l({ unread, last_event_id: null, last_reply_id: null, first: false })
  })
}

function renderShell() {
  return render(
    <AppShell>
      <main data-testid="page">Page body</main>
    </AppShell>,
  )
}

/** The desktop rail's nav (the drawer, when open, renders a second "Main" nav in a portal). */
function rail() {
  return within(screen.getByRole('complementary', { name: 'Sidebar' })).getByRole('navigation', { name: 'Main' })
}

function openDrawer() {
  fireEvent.click(screen.getByRole('button', { name: 'Open menu' }))
  return screen.getByRole('dialog')
}

beforeEach(() => {
  pathname.value = '/'
  live.listeners.clear()
  window.localStorage.clear()
})
afterEach(() => {
  cleanup()
  document.documentElement.removeAttribute('data-nav-menu-open')
  document.documentElement.style.overflow = ''
})

describe('nav config', () => {
  it('every destination appears exactly once, and the legacy AppNav module re-exports the same config', () => {
    const hrefs = NAV_ITEMS.map((i) => i.href)
    expect(new Set(hrefs).size).toBe(hrefs.length)
    for (const href of ['/', '/leads', '/campaigns', '/inbox', '/verify', '/segments', '/suppressions', '/rules', '/reports', '/seo', '/team', '/agents', '/activity', '/jobs', '/tools', '/settings']) {
      expect(hrefs).toContain(href)
    }
    expect(legacy.NAV_ITEMS).toBe(NAV_ITEMS)
    expect(legacy.isActive).toBe(isActive)
  })

  it('the longest matching path owns a URL: sub-pages and old URLs highlight their destination', () => {
    expect(activeHref('/')).toBe('/')
    expect(activeHref('/leads/12')).toBe('/leads')
    expect(activeHref('/find')).toBe('/leads')
    expect(activeHref('/setup')).toBe('/settings')
    expect(activeHref('/settings/users')).toBe('/settings')
    expect(activeHref('/replies')).toBe('/inbox')
    expect(activeHref('/agents/owner')).toBe('/inbox') // owner inbox lives under Inbox, not Agents
    expect(activeHref('/agents')).toBe('/agents')
    expect(activeHref('/costs')).toBe('/campaigns')
    expect(activeHref('/nope')).toBeNull()
    expect(isActive('/', '/')).toBe(true)
    expect(isActive('/leads', '/')).toBe(false)
    expect(isActive('/leadsx', '/leads')).toBe(false)
  })

  it('the phone bottom bar holds the four daily destinations', () => {
    expect(BOTTOM_NAV).toEqual(['/', '/leads', '/campaigns', '/inbox'])
    for (const href of BOTTOM_NAV) expect(NAV_ITEMS.some((i) => i.href === href)).toBe(true)
  })
})

describe('AppShell: desktop rail', () => {
  it('lists every screen in group order and marks the active one (sub-pages included)', () => {
    pathname.value = '/leads/12'
    renderShell()
    const nav = rail()
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(NAV_ITEMS.map((i) => i.label))
    expect(within(nav).getByRole('link', { name: 'Leads' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current')
    expect(within(nav).getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page')).toHaveLength(1)
    expect(screen.getByTestId('page')).toHaveTextContent('Page body')
  })

  it('Operations starts collapsed, opens on a click and remembers it', () => {
    renderShell()
    const toggle = within(rail()).getByRole('button', { name: 'Operations' })
    const group = document.getElementById(toggle.getAttribute('aria-controls')!)!
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(group).toHaveClass('hidden')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(group).not.toHaveClass('hidden')
    expect(window.localStorage.getItem('tapdash.nav.opsOpen')).toBe('1')
    cleanup()
    renderShell()
    expect(within(rail()).getByRole('button', { name: 'Operations' })).toHaveAttribute('aria-expanded', 'true')
  })

  it('Operations is forced open while one of its screens is the current page', () => {
    pathname.value = '/jobs'
    renderShell()
    const toggle = within(rail()).getByRole('button', { name: 'Operations' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(within(rail()).getByRole('link', { name: 'Jobs' })).toHaveAttribute('aria-current', 'page')
    const ops = NAV_GROUPS.find((g) => g.id === 'ops')!
    expect(ops.collapsible).toBe(true)
  })

  it('Inbox shows the live unread count, capped at 99+, and drops it at zero', () => {
    renderShell()
    const inbox = () => within(rail()).getByRole('link', { name: /Inbox/ })
    expect(within(inbox()).queryByTestId('inbox-badge')).toBeNull()
    pushUnread(7)
    expect(within(inbox()).getByTestId('inbox-badge')).toHaveTextContent('7')
    pushUnread(120)
    expect(within(inbox()).getByTestId('inbox-badge')).toHaveTextContent('99+')
    expect(within(inbox()).getByTestId('inbox-badge')).toHaveAttribute('aria-label', '120 unread')
    pushUnread(0)
    expect(within(inbox()).queryByTestId('inbox-badge')).toBeNull()
  })
})

describe('AppShell: phone drawer', () => {
  it('lists every screen, marks the active one, hides the comment pill, and closes on Escape', () => {
    pathname.value = '/jobs'
    renderShell()
    const btn = screen.getByRole('button', { name: 'Open menu' })
    expect(btn).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('dialog')).toBeNull()
    const drawer = openDrawer()
    expect(btn).toHaveAttribute('aria-expanded', 'true')
    const nav = within(drawer).getByRole('navigation', { name: 'Main' })
    const labels = within(nav).getAllByRole('link').map((a) => a.textContent)
    expect([...labels].sort()).toEqual(NAV_ITEMS.map((i) => i.label).sort())
    expect(within(nav).getByRole('link', { name: 'Jobs' })).toHaveAttribute('aria-current', 'page')
    // CommentLayer hides its floating pill while <html> carries this attribute.
    expect(document.documentElement.hasAttribute('data-nav-menu-open')).toBe(true)
    fireEvent.keyDown(drawer, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.documentElement.hasAttribute('data-nav-menu-open')).toBe(false)
  })

  it('stacks above the comment layer (the pill is z-50; the drawer uses the sheet layer)', async () => {
    renderShell()
    const drawer = openDrawer()
    expect(drawer).toHaveClass('z-sheet')
    const { default: config } = await import('../tailwind.config')
    const z = (config.theme?.extend as { zIndex?: Record<string, string> } | undefined)?.zIndex ?? {}
    expect(Number(z.sheet)).toBeGreaterThan(50)
    expect(Number(z.palette)).toBeGreaterThan(Number(z.sheet))
  })

  it('tapping a screen closes it, and so does the close button', () => {
    pathname.value = '/campaigns'
    renderShell()
    fireEvent.click(within(openDrawer()).getByRole('link', { name: 'Leads' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(within(openDrawer()).getByRole('button', { name: 'Close menu' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.documentElement.hasAttribute('data-nav-menu-open')).toBe(false)
  })

  it('a route change closes it', () => {
    pathname.value = '/campaigns'
    const { rerender } = renderShell()
    openDrawer()
    pathname.value = '/leads'
    rerender(
      <AppShell>
        <main data-testid="page">Page body</main>
      </AppShell>,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('growing to desktop width while it is open closes it (pill and scrolling come back)', () => {
    const fire: Record<string, ((e: { matches: boolean }) => void) | undefined> = {}
    const mm = vi.spyOn(window, 'matchMedia').mockImplementation(
      (media: string) =>
        ({
          matches: false,
          media,
          addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => {
            fire[media] = cb
          },
          removeEventListener: () => {
            delete fire[media]
          },
        }) as unknown as MediaQueryList,
    )
    try {
      pathname.value = '/campaigns'
      renderShell()
      openDrawer()
      expect(document.documentElement.hasAttribute('data-nav-menu-open')).toBe(true)
      expect(fire['(min-width: 1024px)']).toBeTypeOf('function')
      act(() => fire['(min-width: 1024px)']?.({ matches: true }))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(document.documentElement.hasAttribute('data-nav-menu-open')).toBe(false)
    } finally {
      mm.mockRestore()
    }
  })
})

describe('AppShell: phone bottom bar', () => {
  it('shows the four daily screens plus Ask and More; More opens the drawer', () => {
    pathname.value = '/campaigns/new'
    renderShell()
    const bar = screen.getByRole('navigation', { name: 'Quick' })
    expect(within(bar).getAllByRole('link').map((a) => a.textContent)).toEqual(['Home', 'Leads', 'Campaigns', 'Inbox'])
    expect(within(bar).getByRole('link', { name: 'Campaigns' })).toHaveAttribute('aria-current', 'page')
    expect(within(bar).getByRole('button', { name: 'Ask' })).toBeInTheDocument()
    fireEvent.click(within(bar).getByRole('button', { name: 'More' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('carries the Inbox badge too', () => {
    renderShell()
    pushUnread(250)
    const bar = screen.getByRole('navigation', { name: 'Quick' })
    expect(within(bar).getByLabelText('250 unread')).toHaveTextContent('99+')
  })
})

describe('AppShell: login page', () => {
  it('renders the page bare: no rail, top bar or bottom bar', () => {
    pathname.value = '/login'
    renderShell()
    expect(screen.getByTestId('page')).toBeInTheDocument()
    expect(screen.queryByRole('complementary', { name: 'Sidebar' })).toBeNull()
    expect(screen.queryByRole('navigation', { name: 'Quick' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open menu' })).toBeNull()
  })
})
