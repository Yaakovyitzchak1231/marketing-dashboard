// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import React from 'react'
import { SeoNav, SEO_TABS } from '@/components/seo/SeoNav'
import { CheckPill, Diff, Flash, Steps } from '@/components/seo/bits'
import { NAV_ITEMS } from '@/components/nav/AppNav'

const { pathname } = vi.hoisted(() => ({ pathname: { value: '/seo' } }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => pathname.value,
  useSearchParams: () => new URLSearchParams(),
}))

describe('SEO section UI', () => {
  it('is its own screen in the app nav', () => {
    expect(NAV_ITEMS.some((i) => i.href === '/seo')).toBe(true)
  })
  it('sub-nav marks the active page (detail pages included)', () => {
    pathname.value = '/seo/todos/12'
    render(<SeoNav />)
    const nav = screen.getByRole('navigation', { name: 'SEO sections' })
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(SEO_TABS.map((t) => t.label))
    expect(within(nav).getByRole('link', { name: 'Fix list' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Overview' })).not.toHaveAttribute('aria-current')
  })
  it('a check that could not be measured says so (never "pass")', () => {
    render(<CheckPill status="unknown" />)
    expect(screen.getByText("Couldn't check")).toBeInTheDocument()
  })
  it('diff shows removed and added lines', () => {
    render(<Diff before="https://www.x.test/partners/" after="https://x.test/partners/" />)
    const d = screen.getByTestId('seo-diff')
    expect(d.textContent).toContain('−https://www.x.test/partners/')
    expect(d.textContent).toContain('+https://x.test/partners/')
  })
  it('flash messages and steps render', () => {
    render(
      <>
        <Flash sp={{ err: 'WordPress answered HTTP 401.' }} />
        <Steps steps={['one', '', 'two']} />
      </>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('WordPress answered HTTP 401.')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })
})
