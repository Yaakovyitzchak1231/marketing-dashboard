/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshCount } from './mock-navigation'
import { resetRoleCache, VIEWER_REFUSAL } from '@/components/auth/useRole'
import { ViewOnlyGuard } from '@/components/auth/ViewOnlyGuard'
import { isViewerRefusal, isWriteForm, NEXT_UNEXPECTED_ACTION_RESPONSE } from '@/components/auth/viewOnly'
import ErrorPage from '@/app/error'

function mockRole(role: string | null) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ role }), { status: 200, headers: { 'content-type': 'application/json' } })),
  )
}

/** A server-action form as React 19 SSR renders it, a GET filter form, and a counter of what got through. */
function Page({ onSubmit }: { onSubmit: (name: string) => void }) {
  return (
    <div
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit((e.target as HTMLFormElement).name)
      }}
    >
      <form name="write" method="POST" encType="multipart/form-data" action="">
        <input type="hidden" name="$ACTION_ID_abc" />
        <button>Save</button>
      </form>
      <form name="clientAction" action="javascript:throw new Error('React form unexpectedly submitted.')">
        <button type="submit">Recompute all now</button>
      </form>
      <form name="search" method="get" action="/leads">
        <input name="q" />
        <button>Search</button>
      </form>
    </div>
  )
}

beforeEach(() => {
  resetRoleCache()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-view-only')
})

describe('ViewOnlyGuard', () => {
  it('blocks write forms for a viewer, shows the note, and leaves GET forms alone', async () => {
    mockRole('viewer')
    const got: string[] = []
    render(
      <>
        <ViewOnlyGuard />
        <Page onSubmit={(n) => got.push(n)} />
      </>,
    )
    await waitFor(() => expect(document.documentElement.hasAttribute('data-view-only')).toBe(true))

    const save = screen.getByText('Save')
    await waitFor(() => expect(save).toHaveAttribute('aria-disabled', 'true'))
    expect(save).toHaveAttribute('title', 'View-only access')
    expect(screen.getByText('Recompute all now')).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('Search')).not.toHaveAttribute('aria-disabled')

    fireEvent.submit(document.forms.namedItem('write')!)
    fireEvent.submit(document.forms.namedItem('clientAction')!)
    expect(got).toEqual([])
    expect(screen.getByRole('status')).toHaveTextContent('View-only access')

    fireEvent.submit(document.forms.namedItem('search')!)
    expect(got).toEqual(['search'])
  })

  it('does nothing for an editor', async () => {
    mockRole('editor')
    const got: string[] = []
    render(
      <>
        <ViewOnlyGuard />
        <Page onSubmit={(n) => got.push(n)} />
      </>,
    )
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(document.documentElement.hasAttribute('data-view-only')).toBe(false)
    expect(screen.getByText('Save')).not.toHaveAttribute('aria-disabled')
    fireEvent.submit(document.forms.namedItem('write')!)
    fireEvent.submit(document.forms.namedItem('search')!)
    expect(got).toEqual(['write', 'search'])
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('turns a refused server action rejection into the note for a viewer', async () => {
    mockRole('viewer')
    render(<ViewOnlyGuard />)
    await waitFor(() => expect(document.documentElement.hasAttribute('data-view-only')).toBe(true))
    const ev = new Event('unhandledrejection', { cancelable: true }) as PromiseRejectionEvent
    Object.defineProperty(ev, 'reason', { value: new Error(NEXT_UNEXPECTED_ACTION_RESPONSE) })
    act(() => {
      window.dispatchEvent(ev)
    })
    expect(ev.defaultPrevented).toBe(true)
    expect(screen.getByRole('status')).toHaveTextContent('viewers can look but not change things')
  })
})

describe('viewOnly helpers', () => {
  it('only counts the generic action error as a refusal for a viewer', () => {
    expect(isViewerRefusal(new Error(VIEWER_REFUSAL), 'editor')).toBe(true)
    expect(isViewerRefusal(new Error(NEXT_UNEXPECTED_ACTION_RESPONSE), 'viewer')).toBe(true)
    expect(isViewerRefusal(new Error(NEXT_UNEXPECTED_ACTION_RESPONSE), 'editor')).toBe(false)
    expect(isViewerRefusal(new Error('fetch failed'), 'viewer')).toBe(false)
  })

  it('leaves forms marked data-viewer-ok alone', () => {
    document.body.innerHTML = '<div data-viewer-ok><form method="post"></form></div>'
    expect(isWriteForm(document.forms[0])).toBe(false)
    document.body.innerHTML = ''
  })
})

describe('app/error.tsx', () => {
  it('shows the calm view-only card for a viewer refusal', async () => {
    mockRole('viewer')
    const reset = vi.fn()
    render(<ErrorPage error={new Error(NEXT_UNEXPECTED_ACTION_RESPONSE)} reset={reset} />)
    expect(await screen.findByText('View-only access')).toBeInTheDocument()
    expect(screen.getByText(/Nothing was changed/)).toBeInTheDocument()
    expect(screen.queryByText(/Instantly/)).toBeNull()
    fireEvent.click(screen.getByText('Back to the page'))
    expect(reset).toHaveBeenCalled()
    expect(refreshCount()).toBe(1)
  })

  it('keeps the real error for anyone else', async () => {
    mockRole('owner')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<ErrorPage error={new Error(NEXT_UNEXPECTED_ACTION_RESPONSE)} reset={() => {}} />)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(screen.getByText('The dashboard hit an error')).toBeInTheDocument()
    expect(screen.queryByText('View-only access')).toBeNull()
  })
})
