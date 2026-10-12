// @vitest-environment jsdom
/**
 * Follow-ups from the prod viewer QA after #96 (Oct 12):
 *  1. A viewer's refused inline edit reads as view-only, not "Couldn't reach the server";
 *     viewers don't enter inline-edit mode at all.
 *  2. The More button drops its "· Settings" name while the Inbox badge shows.
 *  3. The phone nav drawer stacks above the comment layer and hides the "My comments" pill.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import type { LiveChange } from '@/components/ops/live'

vi.mock('server-only', () => ({}))
vi.mock('@/app/actions/edit', () => ({ updateEntityAction: vi.fn(), entityHistoryAction: vi.fn() }))

const { role, live, pathname, refresh } = vi.hoisted(() => ({
  role: { value: 'viewer' as 'viewer' | 'editor' | 'owner' | null },
  live: { listeners: new Set<(c: LiveChange) => void>() },
  pathname: { value: '/' },
  refresh: vi.fn(),
}))
vi.mock('@/components/auth/useRole', async (orig) => ({
  ...(await orig<typeof import('@/components/auth/useRole')>()),
  useRole: () => role.value,
  fetchRole: async () => role.value,
}))
vi.mock('@/components/ops/live', () => ({
  subscribeLive: (l: (c: LiveChange) => void) => {
    live.listeners.add(l)
    return () => live.listeners.delete(l)
  },
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
  usePathname: () => pathname.value,
  useSearchParams: () => new URLSearchParams(),
}))

import { InlineEditCell } from '@/components/edit/InlineEditCell'
import { EditFields } from '@/components/leads/EditFields'
import { CommentForm } from '@/components/leads/CommentForm'
import { BulkBar } from '@/components/leads/BulkBar'
import { ViewOnlyGuard } from '@/components/auth/ViewOnlyGuard'
import { AppNav, moreLabelFits } from '@/components/nav/AppNav'
import { updateEntityAction } from '@/app/actions/edit'
import {
  COULD_NOT_REACH,
  NEXT_UNEXPECTED_ACTION_RESPONSE,
  NO_PERMISSION,
  VIEW_ONLY_EVENT,
  VIEW_ONLY_TOAST,
  failedWriteText,
  isWriteForm,
  thrownWriteText,
} from '@/components/auth/viewOnly'
import { VIEWER_REFUSAL } from '@/components/auth/useRole'

function pushUnread(unread: number) {
  act(() => {
    for (const l of live.listeners) l({ unread, last_event_id: null, last_reply_id: null, first: false })
  })
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  role.value = 'viewer'
  pathname.value = '/'
  live.listeners.clear()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.mocked(updateEntityAction).mockReset()
  document.documentElement.removeAttribute('data-nav-menu-open')
  document.documentElement.style.overflow = ''
})

describe('write-failure words', () => {
  it('a 403 is view-only; other errors keep their own words; only network / bare 5xx say "couldn\'t reach"', () => {
    // View-only words only when we know it's the viewer gate: the body says so, or the role is viewer.
    expect(failedWriteText(403, VIEWER_REFUSAL, 'x', null)).toBe(VIEW_ONLY_TOAST)
    expect(failedWriteText(403, undefined, 'x', 'viewer')).toBe(VIEW_ONLY_TOAST)
    expect(failedWriteText(403, 'Forbidden: Account not authorized', 'x', 'viewer')).toBe(VIEW_ONLY_TOAST)
    // Any other 403: never the viewer note on a guess.
    expect(failedWriteText(403, undefined, 'x', null)).toBe(NO_PERMISSION)
    expect(failedWriteText(403, '', 'x', 'editor')).toBe(NO_PERMISSION)
    expect(failedWriteText(403, 'This needs owner access.', 'x', 'editor')).toBe('This needs owner access.')
    expect(failedWriteText(400, 'Name is required.', 'x', 'viewer')).toBe('Name is required.')
    expect(failedWriteText(502, undefined, 'x', 'owner')).toBe(COULD_NOT_REACH)
    expect(failedWriteText(500, 'Database is down.', 'x', 'owner')).toBe('Database is down.')
    expect(failedWriteText(409, undefined, 'Not saved (409).', 'owner')).toBe('Not saved (409).')

    // Next's thrown "unexpected response" is the viewer gate only when we know they're a viewer.
    expect(thrownWriteText(new Error(NEXT_UNEXPECTED_ACTION_RESPONSE), 'viewer', 'Not saved.')).toBe(VIEW_ONLY_TOAST)
    expect(thrownWriteText(new Error(NEXT_UNEXPECTED_ACTION_RESPONSE), 'owner', 'Not saved.')).toBe(`${COULD_NOT_REACH} Not saved.`)
    expect(thrownWriteText(new TypeError('Failed to fetch'), 'viewer')).toBe(COULD_NOT_REACH)
    expect(thrownWriteText(new Error('Request failed with status 403'), 'editor')).toBe(NO_PERMISSION)
    expect(NO_PERMISSION).toBe('You don’t have permission to change this.')
  })

  it('a client form marked data-write counts as a write form', () => {
    const f = document.createElement('form')
    expect(isWriteForm(f)).toBe(false)
    f.setAttribute('data-write', '')
    expect(isWriteForm(f)).toBe(true)
  })
})

describe('InlineEditCell for a viewer', () => {
  it('never opens an editor; the value is marked view-only and a click asks for the calm note', () => {
    const heard = vi.fn()
    window.addEventListener(VIEW_ONLY_EVENT, heard)
    render(<InlineEditCell type="campaign" id={1} field="goal" value="Book 10 calls" label="Goal" />)
    const btn = screen.getByRole('button', { name: 'Goal (view-only)' })
    expect(btn).toHaveAttribute('aria-disabled', 'true')
    expect(btn).toHaveAttribute('title', 'View-only access')
    fireEvent.click(btn)
    expect(screen.queryByLabelText('Goal')).toBeNull() // no input
    expect(heard).toHaveBeenCalledTimes(1)
    expect(updateEntityAction).not.toHaveBeenCalled()
    window.removeEventListener(VIEW_ONLY_EVENT, heard)
  })

  it('with ViewOnlyGuard mounted, the click shows the same toast the form buttons use', async () => {
    render(
      <>
        <ViewOnlyGuard />
        <InlineEditCell type="campaign" id={1} field="goal" value="Book 10 calls" label="Goal" />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Goal (view-only)' }))
    expect(await screen.findByRole('status')).toHaveTextContent(VIEW_ONLY_TOAST)
  })

  it('a refused save that slips through (role still loading) reads as view-only and reverts', async () => {
    role.value = null // UI doesn't know yet, so the editor opens
    vi.mocked(updateEntityAction).mockRejectedValue(new Error(NEXT_UNEXPECTED_ACTION_RESPONSE))
    const view = render(<InlineEditCell type="campaign" id={1} field="goal" value="Book 10 calls" label="Goal" />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit Goal' }))
    const input = screen.getByLabelText('Goal')
    fireEvent.change(input, { target: { value: 'Book 20 calls' } })
    role.value = 'viewer' // ...and by the time the 403 lands, it does
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent(VIEW_ONLY_TOAST)
    expect(screen.queryByText(/reach the server/)).toBeNull()
    expect(view.container).toHaveTextContent('Book 10 calls')
  })

  it('an editor whose save really fails still hears "Couldn\'t reach the server"', async () => {
    role.value = 'editor'
    vi.mocked(updateEntityAction).mockRejectedValue(new TypeError('Failed to fetch'))
    render(<InlineEditCell type="campaign" id={1} field="goal" value="Book 10 calls" label="Goal" />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit Goal' }))
    const input = screen.getByLabelText('Goal')
    fireEvent.change(input, { target: { value: 'Book 20 calls' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t reach the server. Not saved.')
  })
})

describe('lead edit form, comments and bulk actions', () => {
  const fields = [{ name: 'first_name', label: 'First name', value: 'Dana' }]

  it('EditFields: a viewer does not open the form', () => {
    const heard = vi.fn()
    window.addEventListener(VIEW_ONLY_EVENT, heard)
    render(<EditFields endpoint="/api/leads/7/contacts/9" title="contact" fields={fields} />)
    const edit = screen.getByRole('button', { name: 'Edit contact' })
    expect(edit).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(edit)
    expect(screen.queryByLabelText('First name')).toBeNull()
    expect(heard).toHaveBeenCalledTimes(1)
    window.removeEventListener(VIEW_ONLY_EVENT, heard)
  })

  it('EditFields: a 403 reads as view-only, a network failure as "couldn\'t reach"', async () => {
    role.value = null
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: VIEWER_REFUSAL }, 403)))
    render(<EditFields endpoint="/api/leads/7/contacts/9" title="contact" fields={fields} />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit contact' }))
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Dee' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(VIEW_ONLY_TOAST)

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Couldn’t reach the server. Not saved.'))
  })

  it('CommentForm: the form is a write form (the guard stops it for viewers) and a 403 reads as view-only', async () => {
    role.value = null
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: VIEWER_REFUSAL }, 403)))
    const { container } = render(<CommentForm companyId={7} handles={['tab']} />)
    expect(isWriteForm(container.querySelector('form')!)).toBe(true)
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'hi' } })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(VIEW_ONLY_TOAST)
  })

  it('BulkBar: a viewer\'s write buttons are marked view-only and send nothing', () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL) => json({ lists: [] }, 200))
    vi.stubGlobal('fetch', fetchMock)
    render(<BulkBar selected={{ companyIds: [1, 2], unverifiedContactIds: [] }} onDone={() => {}} />)
    const research = screen.getByRole('button', { name: 'Research selected' })
    expect(research).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(research)
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/api/research'))).toHaveLength(0)
  })

  it('BulkBar: "Add" and "Apply" are never natively disabled for a viewer, so a click still gets the note', () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ lists: [] }, 200)))
    const heard = vi.fn()
    window.addEventListener(VIEW_ONLY_EVENT, heard)
    render(<BulkBar selected={{ companyIds: [1], unverifiedContactIds: [] }} onDone={() => {}} />)
    const add = screen.getByRole('button', { name: 'Add' }) // no list chosen
    const apply = screen.getByRole('button', { name: 'Apply' }) // no stage chosen
    expect(add).not.toBeDisabled()
    expect(apply).not.toBeDisabled()
    fireEvent.click(add)
    fireEvent.click(apply)
    expect(heard).toHaveBeenCalledTimes(2)
    window.removeEventListener(VIEW_ONLY_EVENT, heard)
  })
})

describe('nav: Inbox badge vs "More · Settings"', () => {
  it('moreLabelFits: drops the name only when it would crowd the badge (numbers measured at 1440/1366)', () => {
    // "· Settings" takes 66px (62 + the button's 4px gap). Prod QA: with "99+" the gap was 7px.
    expect(moreLabelFits(7, 66, 66)).toBe(false) // shown, 99+ badge -> 7px left: drop it
    expect(moreLabelFits(73, 0, 66)).toBe(false) // hidden, 99+ badge: showing it would leave 7px: stay hidden
    expect(moreLabelFits(43, 66, 66)).toBe(true) // no badge: 43px left
    expect(moreLabelFits(109, 0, 66)).toBe(true) // inbox cleared: it fits again
    expect(moreLabelFits(73, 0, 30)).toBe(true) // a short name ("· Jobs") fits next to "99+"
    expect(moreLabelFits(5, 0, 0)).toBe(true) // never measured at a width that shows it: nothing to decide
  })

  it('AppNav drops "· Settings" when the measured bar would crowd the 99+ badge, and brings it back', () => {
    role.value = 'owner'
    pathname.value = '/settings'
    // A tiny layout model of the 1440 bar (jsdom has no layout): More ends at 1135 without its
    // name and 1201 with it; the Inbox link starts at 1244, or 1208 with the "99+" badge.
    const isLabel = (el: Element) => el.tagName === 'SPAN' && (el.textContent ?? '').trim().startsWith('·')
    const hasLabel = () => Array.from(document.querySelectorAll('span')).some(isLabel)
    const badge = () => !!document.querySelector('[data-live-bell] span')
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return isLabel(this) ? 62 : 0
    })
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const r = (left: number, right: number) => ({ left, right, width: right - left, top: 0, bottom: 0, height: 0, x: left, y: 0, toJSON: () => ({}) }) as DOMRect
      if (isLabel(this)) return r(1135, 1197)
      if (this.hasAttribute('data-live-bell')) return r(badge() ? 1208 : 1244, 1290)
      if (this.tagName === 'BUTTON' && /More/.test(this.textContent ?? '')) return r(1080, hasLabel() ? 1201 : 1135)
      return r(0, 0)
    })
    try {
      render(<AppNav />)
      const more = within(screen.getByRole('navigation', { name: 'Screens' })).getByRole('button', { name: /More/ })
      expect(more).toHaveTextContent('· Settings')
      pushUnread(120)
      expect(screen.getByRole('link', { name: '120 unread' })).toHaveTextContent('99+')
      expect(more).not.toHaveTextContent('Settings')
      pushUnread(0)
      expect(more).toHaveTextContent('· Settings')
    } finally {
      width.mockRestore()
      rect.mockRestore()
    }
  })
})

describe('phone drawer vs the comment layer', () => {
  it('while the drawer is open the bar stacks above the comment layer (z-[55]) and <html> hides the pill', () => {
    pathname.value = '/campaigns'
    const { container } = render(<AppNav />)
    const bar = container.firstElementChild as HTMLElement
    expect(bar.className).toMatch(/\bz-30\b/)
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
    expect(bar.className).toMatch(/z-\[55\]/)
    expect(document.documentElement.hasAttribute('data-nav-menu-open')).toBe(true)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(bar.className).toMatch(/\bz-30\b/)
    expect(document.documentElement.hasAttribute('data-nav-menu-open')).toBe(false)
  })

  it('growing to desktop width while the drawer is open closes it (pill and scrolling come back)', () => {
    let fire: ((e: { matches: boolean }) => void) | null = null
    const mq = {
      matches: false,
      media: '(min-width: 768px)',
      addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => { fire = cb },
      removeEventListener: () => { fire = null },
    }
    const mm = vi.spyOn(window, 'matchMedia').mockReturnValue(mq as unknown as MediaQueryList)
    try {
      pathname.value = '/campaigns'
      render(<AppNav />)
      fireEvent.click(screen.getByRole('button', { name: 'Menu' }))
      expect(document.documentElement.hasAttribute('data-nav-menu-open')).toBe(true)
      act(() => fire?.({ matches: true }))
      expect(screen.queryByRole('navigation', { name: 'All screens' })).toBeNull()
      expect(document.documentElement.hasAttribute('data-nav-menu-open')).toBe(false)
      expect(document.documentElement.style.overflow).toBe('')
    } finally {
      mm.mockRestore()
    }
  })
})
