import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, waitFor } from '@testing-library/react'

// Server actions are POSTs; middleware.ts refuses every POST from a viewer. The comment layer on
// every page must therefore never fire one on load for a viewer.
const actionMocks = vi.hoisted(() => ({
  listMyCommentsAction: vi.fn(async () => ({ ok: true as const, comments: [], recipients: [{ id: 'tab', display_name: 'Tab' }] })),
  saveCommentDraftAction: vi.fn(),
  discardCommentDraftAction: vi.fn(),
  sendCommentsAction: vi.fn(),
  replyCommentAction: vi.fn(),
  resolveCommentAction: vi.fn(),
}))
vi.mock('@/app/actions/page-comments', () => actionMocks)

import { CommentLayer, VIEW_ONLY_NOTE, type CommentActions } from '@/components/comments/CommentLayer'
import { PageComments, listMyComments } from '@/components/comments/PageComments'
import { resetRoleCache, VIEWER_REFUSAL } from '@/components/auth/useRole'
import { putLocal } from '@/lib/page-comments/drafts'
import { PreferencesProvider, REVIEW_KEY } from '@/components/shell/preferences'
import { GET } from '@/app/api/page-comments/route'

afterEach(() => {
  cleanup()
  localStorage.clear()
  sessionStorage.clear()
  resetRoleCache()
  vi.unstubAllGlobals()
  for (const m of Object.values(actionMocks)) m.mockClear()
})

function stubFetch(role: string | null, listStatus = 200) {
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url)
    if (u === '/api/internal/role') return new Response(JSON.stringify({ role }), { status: 200 })
    if (u === '/api/page-comments') {
      expect(init?.method ?? 'GET').toBe('GET')
      if (listStatus !== 200) return new Response('no', { status: listStatus })
      return new Response(JSON.stringify({ ok: true, comments: [], recipients: [{ id: 'tab', display_name: 'Tab' }] }), { status: 200 })
    }
    throw new Error(`unexpected fetch ${u}`)
  })
  vi.stubGlobal('fetch', f)
  return f
}

const noWrites = () => {
  for (const k of ['saveCommentDraftAction', 'discardCommentDraftAction', 'sendCommentsAction', 'replyCommentAction', 'resolveCommentAction'] as const) {
    expect(actionMocks[k]).not.toHaveBeenCalled()
  }
}

/** The comment layer is part of Review mode (off by default; the provider reads it from localStorage). */
function renderInReviewMode() {
  localStorage.setItem(REVIEW_KEY, '1')
  return render(
    <PreferencesProvider>
      <PageComments />
    </PreferencesProvider>,
  )
}

describe('page comments for a viewer', () => {
  it('renders nothing outside Review mode and makes no request', async () => {
    const f = stubFetch('editor')
    const { container } = render(
      <PreferencesProvider>
        <PageComments />
      </PreferencesProvider>,
    )
    await act(async () => {})
    expect(container).toBeEmptyDOMElement()
    expect(f).not.toHaveBeenCalled()
    noWrites()
  })

  it('lists over GET, never calls a server action, and shows view-only instead of Comment', async () => {
    const f = stubFetch('viewer')
    renderInReviewMode()
    await waitFor(() => expect(screen.getByText(VIEW_ONLY_NOTE)).toBeInTheDocument())
    // The layer renders as soon as the role is known; its list GET starts in an effect just after,
    // so wait for the call instead of asserting it on the same tick (it raced under CI load).
    await waitFor(() => expect(f).toHaveBeenCalledWith('/api/page-comments', expect.anything()))
    expect(actionMocks.listMyCommentsAction).not.toHaveBeenCalled()
    noWrites()
    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull()
    expect(screen.getByRole('button', { name: 'My comments' })).toBeInTheDocument()
  })

  it('an editor keeps the Comment button; the list still comes over GET', async () => {
    const f = stubFetch('editor')
    renderInReviewMode()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Comment' })).toBeInTheDocument())
    expect(screen.queryByText(VIEW_ONLY_NOTE)).toBeNull()
    // The layer renders as soon as the role is known; its list GET starts in an effect just after,
    // so wait for the call instead of asserting it on the same tick (it raced under CI load).
    await waitFor(() => expect(f).toHaveBeenCalledWith('/api/page-comments', expect.anything()))
    expect(actionMocks.listMyCommentsAction).not.toHaveBeenCalled()
  })

  it('a viewer never pushes a draft left on this device to the server', async () => {
    putLocal(localStorage, { client_id: 'left-0000001', page_path: '/leads', body: 'from another login', updated_at: 5, synced_at: null })
    const a: CommentActions = {
      list: vi.fn(async () => ({ ok: true as const, comments: [], recipients: [] })),
      save: vi.fn(),
      discard: vi.fn(),
      send: vi.fn(),
      reply: vi.fn(),
      resolve: vi.fn(),
    }
    render(<CommentLayer actions={a} readOnly />)
    await act(async () => {})
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(a.list).toHaveBeenCalled()
    expect(a.save).not.toHaveBeenCalled()
    expect(screen.getByText(VIEW_ONLY_NOTE)).toBeInTheDocument()
  })

  it('a 403 on the list is an answer, not a thrown error', async () => {
    stubFetch('viewer', 403)
    await expect(listMyComments()).resolves.toEqual({ ok: false, error: VIEWER_REFUSAL })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(listMyComments()).resolves.toEqual({ ok: false, error: 'Could not reach the server.' })
  })

  it('GET /api/page-comments runs the same list action (same session and role check)', async () => {
    const res = await GET()
    expect(actionMocks.listMyCommentsAction).toHaveBeenCalledTimes(1)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ ok: true, comments: [], recipients: [{ id: 'tab', display_name: 'Tab' }] })
  })
})
