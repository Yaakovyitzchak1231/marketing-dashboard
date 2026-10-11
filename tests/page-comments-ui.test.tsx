import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { CommentLayer, type CommentActions } from '@/components/comments/CommentLayer'
import { anchorFor, describe as describeEl, selectorFor, spotFor } from '@/lib/page-comments/anchor'
import { STORE_KEY, loadLocal, merge, putLocal, type LocalDraft } from '@/lib/page-comments/drafts'
import type { PageCommentView } from '@/lib/page-comments/core'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  localStorage.clear()
  sessionStorage.clear()
  vi.useRealTimers()
})

function page() {
  const main = document.createElement('main')
  main.innerHTML = `
    <h1>Leads</h1>
    <table><tbody>
      <tr><td>Acme</td><td>12</td></tr>
      <tr><td>Gem Co</td><td>40</td></tr>
    </tbody></table>
    <button data-testid="export">Export</button>
    <input name="email" value="secret@example.com" />`
  document.body.appendChild(main)
  return main
}

describe('anchoring a pin to an element', () => {
  it('builds a selector that finds the same element again', () => {
    const main = page()
    const cell = main.querySelectorAll('td')[2]
    const sel = selectorFor(cell)!
    expect(document.querySelector(sel)).toBe(cell)
    expect(selectorFor(main.querySelector('button')!)).toBe('[data-testid="export"]')
  })

  it("describes the element in words and never snapshots a field's value", () => {
    const main = page()
    expect(describeEl(main.querySelector('button')!)).toEqual({ anchor_label: 'button "Export"', anchor_text: 'Export' })
    const field = describeEl(main.querySelector('input')!)
    expect(field.anchor_label).toBe('field "email"')
    expect(field.anchor_text).toBeNull()
    expect(JSON.stringify(anchorFor(main.querySelector('input')!, 0, 0))).not.toContain('secret@example.com')
  })

  it('falls back to the old spot on the page when the element is gone', () => {
    page()
    expect(spotFor({ selector: 'main > nav', off_x: 0.5, off_y: 0.5, x_pct: 0.5, y_pct: 0.25 })?.found).toBe(false)
    expect(spotFor({ selector: null, off_x: null, off_y: null, x_pct: null, y_pct: null })).toBeNull()
  })
})

const view = (over: Partial<PageCommentView>): PageCommentView => ({
  id: 1, client_id: 'srv-00000001', author: 'owner', recipient: 'tab', recipient_name: 'Tab', page_path: '/leads', page_title: 'Leads',
  selector: null, anchor_label: null, anchor_text: null, off_x: null, off_y: null, x_pct: 0.1, y_pct: 0.1, body: 'server text', tag: null,
  status: 'draft', delivery: null, delivery_error: null, sent_at: null, seen_at: null, resolved_at: null,
  created_at: '2026-10-09T10:00:00.000Z', updated_at: '2026-10-09T10:00:00.000Z', replies: [], ...over,
})
const local = (over: Partial<LocalDraft>): LocalDraft => ({ client_id: 'loc-00000001', page_path: '/team', body: 'typed here', updated_at: 2000, synced_at: null, ...over })

describe('merging this device with the server', () => {
  it('unsaved edits on this device win and are pushed; confirmed ones defer to the server', () => {
    const name = (id: string) => id
    const m = merge(
      [view({ client_id: 'a-0000000001', body: 'old' }), view({ client_id: 'b-0000000001', body: 'server wins' })],
      {
        'a-0000000001': local({ client_id: 'a-0000000001', page_path: '/leads', body: 'newer, unsaved', updated_at: 5, synced_at: 3 }),
        'b-0000000001': local({ client_id: 'b-0000000001', page_path: '/leads', body: 'stale', updated_at: 3, synced_at: 3 }),
        'c-0000000001': local({ client_id: 'c-0000000001', body: 'only here' }),
      },
      name,
    )
    const body = Object.fromEntries(m.pins.map((p) => [p.client_id, p.body]))
    expect(body).toEqual({ 'a-0000000001': 'newer, unsaved', 'b-0000000001': 'server wins', 'c-0000000001': 'only here' })
    expect(m.push.map((d) => d.client_id).sort()).toEqual(['a-0000000001', 'c-0000000001'])
  })

  it('drops the local copy once the server says it was sent, or discarded elsewhere', () => {
    const m = merge(
      [view({ client_id: 'a-0000000001', status: 'sent', sent_at: '2026-10-09T10:01:00.000Z' })],
      { 'a-0000000001': local({ client_id: 'a-0000000001' }), 'gone-000001': local({ client_id: 'gone-000001', updated_at: 3, synced_at: 3 }) },
      (id) => id,
    )
    expect(m.drop.sort()).toEqual(['a-0000000001', 'gone-000001'])
    expect(m.pins.map((p) => p.status)).toEqual(['sent'])
  })
})

function fakeActions(over: Partial<CommentActions> = {}) {
  const saved: unknown[] = []
  const a: CommentActions = {
    list: vi.fn(async () => ({ ok: true as const, comments: [], recipients: [{ id: 'tab', display_name: 'Tab' }, { id: 'hermes', display_name: 'Hermes' }] })),
    save: vi.fn(async (d) => {
      saved.push(d)
      return { ok: true as const, comment: view({ client_id: d.client_id, body: d.body ?? '', page_path: d.page_path, updated_at: new Date().toISOString() }) }
    }),
    discard: vi.fn(async () => ({ ok: true as const, discarded: true })),
    send: vi.fn(async (ids: string[]) => ({ ok: true as const, results: ids.map((id) => ({ client_id: id, ok: true, id: 1 })) })),
    reply: vi.fn(async () => ({ ok: true as const })),
    resolve: vi.fn(async () => ({ ok: true as const, comment: view({ status: 'resolved' }) })),
    ...over,
  }
  return { a, saved }
}

describe('the comment layer', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/')
  })

  it('Comment -> tap an element -> type: saved on this device at once and to the server after a pause', async () => {
    const main = page()
    const { a, saved } = fakeActions()
    render(<CommentLayer actions={a} />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    expect(screen.getByRole('status')).toHaveTextContent('Tap anything on the page')
    const cell = main.querySelectorAll('td')[2]
    await act(async () => {
      fireEvent.click(cell)
    })
    const box = screen.getByRole('textbox', { name: 'Comment' })
    expect(screen.getByRole('dialog', { name: 'New comment' })).toHaveTextContent('On table cell')
    vi.useFakeTimers()
    fireEvent.change(box, { target: { value: 'Wrong count here' } })
    // In this browser immediately...
    const stored = Object.values(loadLocal(localStorage))
    expect(stored).toHaveLength(1)
    expect(stored[0].body).toBe('Wrong count here')
    expect(stored[0].selector && document.querySelector(stored[0].selector)).toBe(cell)
    // ...and on the server once typing pauses.
    await act(async () => {
      vi.advanceTimersByTime(700)
    })
    vi.useRealTimers()
    await act(async () => {})
    expect((saved.at(-1) as { body: string }).body).toBe('Wrong count here')
    expect(screen.getByRole('button', { name: 'My comments, 1 draft' })).toBeInTheDocument()
  })

  it('a draft written earlier comes back after a reload even when the server is unreachable', async () => {
    putLocal(localStorage, local({ client_id: 'keep-0000001', page_path: '/campaigns', page_title: 'Campaigns', body: 'half-written thought' }))
    const { a } = fakeActions({ list: vi.fn(async () => ({ ok: false as const, error: 'offline' })), save: vi.fn(async () => ({ ok: false as const, error: 'offline' })) })
    render(<CommentLayer actions={a} />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'My comments, 1 draft' }))
    expect(screen.getByRole('dialog', { name: 'My comments' })).toHaveTextContent('half-written thought')
    expect(localStorage.getItem(STORE_KEY)).toContain('half-written thought')
  })

  it('sends all drafts at once from the tray', async () => {
    putLocal(localStorage, local({ client_id: 'one-00000001', page_path: '/leads', body: 'first' }))
    putLocal(localStorage, local({ client_id: 'two-00000001', page_path: '/team', body: 'second', updated_at: 3000 }))
    const { a } = fakeActions()
    render(<CommentLayer actions={a} />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: /My comments/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send all 2' }))
    })
    expect(a.send).toHaveBeenCalledWith(expect.arrayContaining(['one-00000001', 'two-00000001']))
    expect(loadLocal(localStorage)).toEqual({})
  })

  it('a queued recovery save cannot restore a sent draft when the next refresh is offline', async () => {
    vi.useFakeTimers()
    const draft = local({ client_id: 'queued-00001', body: 'send this' })
    putLocal(localStorage, draft)
    const { a } = fakeActions()
    vi.mocked(a.list).mockResolvedValueOnce({ ok: true, comments: [], recipients: [] }).mockResolvedValue({ ok: false, error: 'offline' })
    render(<CommentLayer actions={a} />)
    await act(async () => {}) // refresh schedules a recovery save for this local draft
    fireEvent.click(screen.getByRole('button', { name: /My comments/ }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
    expect(screen.getByRole('heading', { name: 'Drafts (0)' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Sent (1)' })).toBeInTheDocument()
    expect(loadLocal(localStorage)).toEqual({})
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(a.save).toHaveBeenCalledTimes(1)
    expect(loadLocal(localStorage)).toEqual({})
  })

  it('an in-flight autosave cannot restore a draft after sending succeeds', async () => {
    vi.useFakeTimers()
    const draft = local({ client_id: 'saving-00001', body: 'send this' })
    putLocal(localStorage, draft)
    const { a } = fakeActions()
    vi.mocked(a.list).mockResolvedValueOnce({ ok: true, comments: [], recipients: [] }).mockResolvedValue({ ok: false, error: 'offline' })
    let finish!: (r: Awaited<ReturnType<CommentActions['save']>>) => void
    vi.mocked(a.save).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    render(<CommentLayer actions={a} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(a.save).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /My comments/ }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
    expect(a.send).toHaveBeenCalledTimes(1)
    expect(loadLocal(localStorage)).toEqual({})
    await act(async () => { finish({ ok: true, comment: view({ client_id: draft.client_id, body: 'send this' }) }) })
    expect(loadLocal(localStorage)).toEqual({})
  })

  it('a partial send keeps the failed draft editable and permits a later retry', async () => {
    vi.useFakeTimers()
    putLocal(localStorage, local({ client_id: 'sent-0000001', body: 'first' }))
    putLocal(localStorage, local({ client_id: 'retry-000001', body: 'second' }))
    const { a } = fakeActions()
    vi.mocked(a.list).mockResolvedValueOnce({ ok: true, comments: [], recipients: [] }).mockResolvedValue({ ok: false, error: 'offline' })
    vi.mocked(a.send).mockResolvedValueOnce({ ok: true, results: [
      { client_id: 'sent-0000001', ok: true, id: 1 },
      { client_id: 'retry-000001', ok: false, error: 'unavailable' },
    ] })
    render(<CommentLayer actions={a} />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: /My comments/ }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send all 2' })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(Object.keys(loadLocal(localStorage))).toEqual(['retry-000001'])
    expect(screen.getByRole('heading', { name: 'Drafts (1)' })).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send' })) })
    expect(a.send).toHaveBeenLastCalledWith(['retry-000001'])
    expect(loadLocal(localStorage)).toEqual({})
    expect(screen.getByRole('heading', { name: 'Sent (2)' })).toBeInTheDocument()
  })

  it('an in-flight autosave cannot restore a discarded draft before the next render', async () => {
    vi.useFakeTimers()
    const main = page()
    let finish!: (r: Awaited<ReturnType<CommentActions['save']>>) => void
    const { a } = fakeActions({ save: vi.fn<CommentActions['save']>(() => new Promise((resolve) => { finish = resolve })) })
    render(<CommentLayer actions={a} />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    fireEvent.click(main.querySelector('h1')!)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    const [draft] = Object.values(loadLocal(localStorage))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
      finish({ ok: true, comment: view({ client_id: draft.client_id }) })
    })
    expect(a.discard).toHaveBeenCalledWith(draft.client_id)
    expect(loadLocal(localStorage)).toEqual({})
    expect(screen.queryByRole('dialog', { name: 'New comment' })).toBeNull()
  })

  it('a sent comment shows its thread, status and a reply box', async () => {
    // The test router sits on '/', so the comment lives there; ?pin=5 opens it.
    window.history.replaceState(null, '', '/?pin=5')
    const sent = view({
      id: 5, client_id: 'sent-0000005', page_path: '/', status: 'replied', body: 'Why 40?', sent_at: '2026-10-09T10:01:00.000Z',
      replies: [{ id: 1, author: 'tab', author_name: 'Tab', author_kind: 'agent', body: 'Duplicate rows, fixed.', created_at: '2026-10-09T10:05:00.000Z' }],
    })
    const { a } = fakeActions({ list: vi.fn(async () => ({ ok: true as const, comments: [sent], recipients: [{ id: 'tab', display_name: 'Tab' }] })) })
    render(<CommentLayer actions={a} />)
    await act(async () => {})
    const dlg = screen.getByRole('dialog', { name: 'Comment' })
    expect(dlg).toHaveTextContent('Replied')
    expect(dlg).toHaveTextContent('Duplicate rows, fixed.')
    fireEvent.change(screen.getByRole('textbox', { name: 'Reply' }), { target: { value: 'thanks' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reply' }))
    })
    expect(a.reply).toHaveBeenCalledWith(5, 'thanks')
    // Closing it keeps it closed, even when the list refreshes.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    expect(screen.queryByRole('dialog', { name: 'Comment' })).toBeNull()
  })

  it('a failed discard puts the draft back instead of hiding it', async () => {
    vi.useFakeTimers()
    const main = page()
    const { a } = fakeActions({ discard: vi.fn(async () => ({ ok: false as const, error: 'still there' })) })
    render(<CommentLayer actions={a} />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    await act(async () => { fireEvent.click(main.querySelector('h1')!) })
    fireEvent.change(screen.getByRole('textbox', { name: 'Comment' }), { target: { value: 'keep this' } })
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete draft' })) })
    expect(a.discard).toHaveBeenCalled()
    expect(Object.values(loadLocal(localStorage)).map((d) => d.body)).toEqual(['keep this'])
    expect(screen.getByRole('button', { name: /keep this/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /My comments/ }))
    expect(screen.getByText('Could not discard that draft. It is still here.')).toBeInTheDocument()
  })

  it('a pin closed before anything was written is thrown away', async () => {
    const main = page()
    const { a } = fakeActions()
    render(<CommentLayer actions={a} />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    await act(async () => {
      fireEvent.click(main.querySelector('h1')!)
    })
    expect(screen.getByRole('dialog', { name: 'New comment' })).toHaveTextContent('On heading "Leads"')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    })
    expect(screen.queryByRole('dialog', { name: 'New comment' })).toBeNull()
    expect(loadLocal(localStorage)).toEqual({})
    expect(a.discard).toHaveBeenCalled()
  })
})
