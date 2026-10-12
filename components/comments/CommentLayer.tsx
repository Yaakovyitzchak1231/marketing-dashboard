'use client'

/**
 * "Comment on this": pin a note for an agent to any spot on any page.
 *
 *  - Comment button (bottom right) -> pick mode: tap/click any element and a pin lands there.
 *  - The comment box autosaves on every keystroke: to this browser at once, and to the server a
 *    moment later. Switching pages, refreshing or closing the tab loses nothing.
 *  - "My comments" lists every draft and sent comment across pages; tap one to jump to its page and
 *    pin. Send one at a time, or all drafts at once.
 *  - Sent comments show their status (sent / seen / replied / resolved) and the agent's replies.
 *
 * The data door is passed in (`actions`) so this component is testable without a server.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { UI_ATTR, anchorFor, inCommentUi, pageTitle, spotFor, type PinSpot } from '@/lib/page-comments/anchor'
import {
  loadLocal, loadReply, localToPin, merge, newClientId, onPage, pinToLocal, putLocal, putReply, removeLocal, type Pin,
} from '@/lib/page-comments/drafts'
import type { CommentTag, DraftInput, PageCommentView, SendResult } from '@/lib/page-comments/core'

type Fail = { ok: false; error: string }
export interface CommentActions {
  list: () => Promise<{ ok: true; comments: PageCommentView[]; recipients: { id: string; display_name: string }[] } | Fail>
  save: (d: DraftInput) => Promise<{ ok: true; comment: PageCommentView } | Fail>
  discard: (clientId: string) => Promise<{ ok: true; discarded: boolean } | Fail>
  send: (clientIds: string[]) => Promise<{ ok: true; results: SendResult[] } | Fail>
  reply: (id: number, body: string) => Promise<{ ok: true } | Fail>
  resolve: (id: number, resolved: boolean) => Promise<{ ok: true; comment: PageCommentView } | Fail>
}

const TAG_OPTIONS: { id: CommentTag; label: string }[] = [
  { id: 'fix', label: 'Needs fix' },
  { id: 'question', label: 'Question' },
  { id: 'idea', label: 'Idea' },
]
const STATUS_LABEL: Record<Pin['status'], string> = { draft: 'Draft', sent: 'Sent', seen: 'Seen', replied: 'Replied', resolved: 'Resolved' }
const STATUS_CLS: Record<Pin['status'], string> = {
  draft: 'text-warn',
  sent: 'text-ink-muted',
  seen: 'text-ink-muted',
  replied: 'text-accent',
  resolved: 'text-good',
}
const PREFS_KEY = 'tapdash.pageComments.prefs.v1'
const OPEN_KEY = 'tapdash.pageComments.open'
const SAVE_DELAY_MS = 600
const POLL_MS = 30_000

type SaveState = 'saved' | 'saving' | 'local' | 'error'

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}
function session(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null
  } catch {
    return null
  }
}
function when(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const mins = Math.round((Date.now() - d.getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 24 * 60) return `${Math.round(mins / 60)} h ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
function pinLabel(p: Pin): string {
  return p.page_title || p.page_path.split('?')[0] || '/'
}

/** What a viewer sees in place of the Comment button, and if any write is tried anyway. */
export const VIEW_ONLY_NOTE = "View-only access: you can't comment"

export function CommentLayer({ actions, readOnly = false }: { actions: CommentActions; readOnly?: boolean }) {
  const pathname = usePathname() ?? '/'
  const router = useRouter()
  const [pins, setPins] = useState<Pin[]>([])
  const [recipients, setRecipients] = useState<{ id: string; display_name: string }[]>([{ id: 'tab', display_name: 'Tab' }])
  const [picking, setPicking] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [trayOpen, setTrayOpen] = useState(false)
  const [showPins, setShowPins] = useState(true)
  const [showResolved, setShowResolved] = useState(false)
  const [saveState, setSaveState] = useState<Record<string, SaveState>>({})
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [spots, setSpots] = useState<Record<string, PinSpot | null>>({})
  const [narrow, setNarrow] = useState(false)
  const [, setTick] = useState(0)

  const pinsRef = useRef<Pin[]>([])
  pinsRef.current = pins
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const editAt = useRef<Record<string, number>>({})
  // Sending/discarding is final for a draft ID, even before React renders the
  // new state or while a recovery timer / older network save is still pending.
  const closedDrafts = useRef(new Set<string>())
  const nameOf = useCallback((id: string) => recipients.find((r) => r.id === id)?.display_name ?? id, [recipients])
  const nameRef = useRef(nameOf)
  nameRef.current = nameOf
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly

  // ---------------------------------------------------------------- server sync

  const saveNow = useCallback(
    async (clientId: string) => {
      clearTimeout(timers.current[clientId])
      delete timers.current[clientId]
      if (closedDrafts.current.has(clientId)) return
      // A viewer can't save (the server refuses it); a draft left on this device stays on it.
      if (readOnlyRef.current) return setSaveState((s) => ({ ...s, [clientId]: 'local' }))
      const local = loadLocal(storage())[clientId]
      const p = pinsRef.current.find((x) => x.client_id === clientId) ?? (local ? localToPin(local, nameRef.current) : undefined)
      if (!p || p.status !== 'draft') return
      const stamp = editAt.current[clientId] ?? Date.now()
      setSaveState((s) => ({ ...s, [clientId]: 'saving' }))
      const r = await actions.save(pinToLocal(p, stamp, null)).catch(() => ({ ok: false, error: 'offline' }) as Fail)
      if (closedDrafts.current.has(clientId)) return
      if (r.ok) {
        // Confirmed: remember which edit the server holds. Newer edits typed meanwhile stay unsynced.
        const latest = editAt.current[clientId] ?? stamp
        const cur = pinsRef.current.find((x) => x.client_id === clientId)
        // Only update a copy this device still holds: if the draft was sent or discarded while this
        // save was in flight, its local copy is already gone and must not be written back.
        if (cur && cur.status === 'draft' && clientId in loadLocal(storage())) putLocal(storage(), pinToLocal(cur, latest, stamp))
        setPins((all) => all.map((x) => (x.client_id === clientId ? { ...x, id: r.comment.id, unsynced: latest > stamp } : x)))
        setSaveState((s) => ({ ...s, [clientId]: latest > stamp ? 'saving' : 'saved' }))
      } else {
        setSaveState((s) => ({ ...s, [clientId]: 'local' }))
      }
    },
    [actions],
  )

  const refresh = useCallback(async () => {
    const r = await actions.list().catch(() => null)
    const local = loadLocal(storage())
    if (!r || !r.ok) {
      // Server unreachable: show what this device has, and keep it.
      setPins((cur) => {
        const known = new Set(cur.map((p) => p.client_id))
        const extra = Object.values(local).filter((l) => !known.has(l.client_id)).map((l) => localToPin(l, nameRef.current))
        return extra.length ? [...extra, ...cur] : cur
      })
      return
    }
    if (r.recipients.length) setRecipients(r.recipients)
    const name = (id: string) => r.recipients.find((x) => x.id === id)?.display_name ?? id
    const m = merge(r.comments, local, name)
    for (const id of m.drop) removeLocal(storage(), id)
    // Keep what is being typed right now (a refresh must never overwrite the open box).
    setPins((cur) => {
      const typing = new Map(cur.filter((p) => p.status === 'draft' && timers.current[p.client_id]).map((p) => [p.client_id, p]))
      return m.pins.map((p) => typing.get(p.client_id) ?? p)
    })
    for (const l of m.push) {
      editAt.current[l.client_id] = l.updated_at
      setTimeout(() => void saveNow(l.client_id), 0)
    }
  }, [actions, saveNow])

  useEffect(() => {
    void refresh()
    try {
      const prefs = JSON.parse(storage()?.getItem(PREFS_KEY) ?? '{}') as { showPins?: boolean }
      if (prefs.showPins === false) setShowPins(false)
    } catch {
      /* default */
    }
    const flush = () => {
      for (const id of Object.keys(timers.current)) void saveNow(id)
    }
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [refresh, saveNow])

  // Agent replies arrive on their own: poll while the tab is visible and something is waiting on an agent.
  const waiting = pins.some((p) => p.status === 'sent' || p.status === 'seen' || p.status === 'replied')
  useEffect(() => {
    if (!waiting) return
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, POLL_MS)
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(t)
      window.removeEventListener('focus', onFocus)
    }
  }, [waiting, refresh])

  // ---------------------------------------------------------------- editing

  const edit = useCallback(
    (clientId: string, patch: Partial<Pick<Pin, 'body' | 'recipient' | 'tag'>>) => {
      const stamp = Date.now()
      editAt.current[clientId] = stamp
      let next: Pin | undefined
      setPins((all) =>
        all.map((p) => {
          if (p.client_id !== clientId) return p
          next = { ...p, ...patch, recipient_name: patch.recipient ? nameRef.current(patch.recipient) : p.recipient_name, updated_at: new Date(stamp).toISOString(), unsynced: true }
          return next
        }),
      )
      // Saved to this browser on the same keystroke...
      const cur = pinsRef.current.find((p) => p.client_id === clientId)
      if (cur) putLocal(storage(), pinToLocal({ ...cur, ...patch }, stamp, null))
      setSaveState((s) => ({ ...s, [clientId]: 'saving' }))
      // ...and to the server a moment after typing pauses.
      clearTimeout(timers.current[clientId])
      timers.current[clientId] = setTimeout(() => void saveNow(clientId), SAVE_DELAY_MS)
      void next
    },
    [saveNow],
  )

  const startPin = useCallback(
    (el: Element, x: number, y: number) => {
      const a = anchorFor(el, x, y)
      const clientId = newClientId()
      const stamp = Date.now()
      const draft = {
        client_id: clientId,
        recipient: 'tab',
        page_path: `${window.location.pathname}${window.location.search}`,
        page_title: pageTitle(document),
        ...a,
        body: '',
        tag: null,
        updated_at: stamp,
        synced_at: null,
      }
      editAt.current[clientId] = stamp
      putLocal(storage(), draft)
      setPins((all) => [localToPin(draft, nameRef.current), ...all])
      setSaveState((s) => ({ ...s, [clientId]: 'saving' }))
      setOpenId(clientId)
      setTrayOpen(false)
      timers.current[clientId] = setTimeout(() => void saveNow(clientId), 0)
    },
    [saveNow],
  )

  // ---------------------------------------------------------------- pick mode

  const [hover, setHover] = useState<DOMRect | null>(null)
  useEffect(() => {
    if (!picking) return
    const move = (e: MouseEvent) => {
      const t = e.target as Element | null
      if (!t || inCommentUi(t)) return setHover(null)
      setHover(t.getBoundingClientRect())
    }
    const click = (e: MouseEvent) => {
      const t = e.target as Element | null
      if (!t || inCommentUi(t)) return
      e.preventDefault()
      e.stopPropagation()
      setPicking(false)
      setHover(null)
      startPin(t, e.clientX, e.clientY)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPicking(false)
        setHover(null)
      }
    }
    document.addEventListener('mousemove', move, true)
    document.addEventListener('click', click, true)
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('mousemove', move, true)
      document.removeEventListener('click', click, true)
      document.removeEventListener('keydown', key, true)
    }
  }, [picking, startPin])

  // ---------------------------------------------------------------- pins on this page

  const visible = useMemo(
    () => pins.filter((p) => onPage(p, pathname) && (showResolved || p.status !== 'resolved')),
    [pins, pathname, showResolved],
  )
  const place = useCallback(() => {
    const next: Record<string, PinSpot | null> = {}
    for (const p of visible) next[p.client_id] = spotFor(p, document)
    setSpots(next)
    setNarrow(window.innerWidth < 640)
  }, [visible])
  useEffect(() => {
    place()
    const t = setInterval(place, 1500) // pages render data late; pins follow their elements
    const first = setTimeout(place, 300)
    window.addEventListener('resize', place)
    return () => {
      clearInterval(t)
      clearTimeout(first)
      window.removeEventListener('resize', place)
    }
  }, [place])

  // Opening a pin from the tray (other page) or from a link (?pin=12) once the page is here. Once per
  // request: closing the box must not reopen it on the next refresh.
  const handled = useRef<string | null>(null)
  useEffect(() => {
    const s = session()
    const wanted = s?.getItem(OPEN_KEY)
    const q = new URLSearchParams(window.location.search).get('pin')
    const key = wanted ? `open:${wanted}` : q ? `${window.location.pathname}?pin=${q}` : null
    if (!key || key === handled.current) return
    const target = wanted ? pins.find((p) => p.client_id === wanted) : pins.find((p) => String(p.id) === q)
    if (!target || !onPage(target, pathname)) return
    handled.current = key
    s?.removeItem(OPEN_KEY)
    if (target.status === 'resolved') setShowResolved(true)
    setShowPins(true)
    setOpenId(target.client_id)
    setTimeout(() => {
      const spot = spotFor(target, document)
      if (spot) window.scrollTo({ top: Math.max(0, spot.y - window.innerHeight / 3), behavior: 'smooth' })
    }, 350)
  }, [pathname, pins])

  const goTo = useCallback(
    (p: Pin) => {
      setTrayOpen(false)
      if (onPage(p, pathname)) {
        if (p.status === 'resolved') setShowResolved(true)
        setShowPins(true)
        setOpenId(p.client_id)
        const spot = spotFor(p, document)
        if (spot) window.scrollTo({ top: Math.max(0, spot.y - window.innerHeight / 3), behavior: 'smooth' })
        return
      }
      session()?.setItem(OPEN_KEY, p.client_id)
      router.push(p.page_path)
    },
    [pathname, router],
  )

  // ---------------------------------------------------------------- send / discard / thread

  const send = useCallback(
    async (ids: string[]) => {
      const ready = ids.filter((id) => !closedDrafts.current.has(id) && pinsRef.current.find((p) => p.client_id === id && p.status === 'draft')?.body.trim())
      if (!ready.length) return setNotice('Write something first.')
      if (readOnlyRef.current) return setNotice(VIEW_ONLY_NOTE)
      setBusy(true)
      setNotice(null)
      await Promise.all(ready.map((id) => saveNow(id))) // the server sends what you see
      const r = await actions.send(ready).catch(() => ({ ok: false, error: 'Could not reach the server. Your drafts are kept.' }) as Fail)
      setBusy(false)
      if (!r.ok) return setNotice(r.error)
      const ok = r.results.filter((x) => x.ok)
      for (const x of ok) {
        closedDrafts.current.add(x.client_id)
        clearTimeout(timers.current[x.client_id])
        delete timers.current[x.client_id]
        removeLocal(storage(), x.client_id)
      }
      // The send receipt is evidence of success even if the following list
      // request fails. Do not leave a successfully sent comment editable.
      setPins((all) => all.map((p) => {
        const receipt = ok.find((x) => x.client_id === p.client_id)
        return receipt && p.status === 'draft' ? { ...p, id: receipt.id ?? p.id, status: 'sent', unsynced: false } : p
      }))
      const bad = r.results.filter((x) => !x.ok)
      setNotice(bad.length ? `${ok.length} sent. ${bad.length} not sent: ${bad[0].error}` : ok.length === 1 ? 'Sent.' : `${ok.length} comments sent.`)
      await refresh()
    },
    [actions, refresh, saveNow],
  )

  const discard = useCallback(
    async (clientId: string) => {
      const before = pinsRef.current.find((p) => p.client_id === clientId)
      closedDrafts.current.add(clientId)
      clearTimeout(timers.current[clientId])
      delete timers.current[clientId]
      removeLocal(storage(), clientId)
      setPins((all) => all.filter((p) => p.client_id !== clientId))
      setOpenId((o) => (o === clientId ? null : o))
      if (readOnlyRef.current) return // only ever on this device for a viewer
      const r = await actions.discard(clientId).catch(() => null)
      if (r?.ok) return
      // The server still holds this draft. Leaving the ID closed would hide a draft that exists,
      // and saveNow()/send() would skip it, so it could never be saved or sent again until a
      // remount. Reopen it, put the text back on this device, and say so.
      closedDrafts.current.delete(clientId)
      if (before) {
        putLocal(storage(), pinToLocal(before, editAt.current[clientId] ?? Date.now(), before.unsynced ? null : Date.now()))
        setPins((all) => (all.some((p) => p.client_id === clientId) ? all : [before, ...all]))
      }
      setNotice('Could not discard that draft. It is still here.')
    },
    [actions],
  )

  const reply = useCallback(
    async (p: Pin, body: string) => {
      if (!p.id || !body.trim()) return false
      if (readOnlyRef.current) {
        setNotice(VIEW_ONLY_NOTE)
        return false
      }
      setBusy(true)
      const r = await actions.reply(p.id, body).catch(() => ({ ok: false, error: 'Could not reach the server. Your reply is kept here.' }) as Fail)
      setBusy(false)
      if (!r.ok) {
        setNotice(r.error)
        return false
      }
      await refresh()
      return true
    },
    [actions, refresh],
  )

  const resolve = useCallback(
    async (p: Pin, resolved: boolean) => {
      if (!p.id) return
      if (readOnlyRef.current) return setNotice(VIEW_ONLY_NOTE)
      const r = await actions.resolve(p.id, resolved).catch(() => ({ ok: false, error: 'Could not reach the server.' }) as Fail)
      if (!r.ok) return setNotice(r.error)
      setPins((all) => all.map((x) => (x.client_id === p.client_id ? { ...r.comment, unsynced: false } : x)))
      if (resolved) setOpenId(null)
    },
    [actions],
  )

  // Relative times ("2 min ago") stay fresh while the tray is open.
  useEffect(() => {
    if (!trayOpen) return
    const t = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [trayOpen])

  if (pathname === '/login') return null

  const drafts = pins.filter((p) => p.status === 'draft')
  const sentPins = pins.filter((p) => p.status !== 'draft' && (showResolved || p.status !== 'resolved'))
  const resolvedCount = pins.filter((p) => p.status === 'resolved').length
  const open = openId ? pins.find((p) => p.client_id === openId) ?? null : null
  const openSpot = open ? spots[open.client_id] ?? spotFor(open, document) : null
  const ui = { [UI_ATTR]: '' }

  return (
    <>
      {/* Room under the last row of the page for the fixed comment bar below (bottom-4, ~44px
          tall), so it never sits on top of content. Rendered here, not as body padding, so pages
          without the bar (/login) don't get an empty scroll at the bottom. */}
      <div {...ui} aria-hidden="true" data-comment-bar-spacer="" className="h-[calc(4.5rem_+_env(safe-area-inset-bottom))] print:hidden" />

      {/* Pins, in page coordinates so they scroll with the page. */}
      {showPins ? (
        <div {...ui} className="pointer-events-none absolute left-0 top-0 z-40 h-0 w-0 print:hidden" aria-label="Comment pins">
          {visible.map((p, i) => {
            const s = spots[p.client_id]
            if (!s) return null
            return (
              <button
                key={p.client_id}
                type="button"
                onClick={() => setOpenId((o) => (o === p.client_id ? null : p.client_id))}
                aria-label={`Comment ${i + 1}: ${STATUS_LABEL[p.status]}${p.body ? ` — ${p.body.slice(0, 40)}` : ''}`}
                title={s.found ? undefined : 'The element this was pinned to has moved; shown at its old spot'}
                style={{ left: s.x - 12, top: s.y - 24 }}
                className={`pointer-events-auto absolute flex h-6 min-w-6 items-center justify-center rounded-full rounded-bl-none border px-1.5 text-[11px] font-semibold tabular-nums shadow-sm ${
                  p.status === 'draft'
                    ? 'border-warn bg-warn-soft text-warn'
                    : p.status === 'resolved'
                      ? 'border-line bg-surface text-ink-faint'
                      : p.status === 'replied'
                        ? 'border-accent bg-accent text-accent-soft'
                        : 'border-accent bg-surface text-accent'
                } ${openId === p.client_id ? 'ring-2 ring-accent/40' : ''} ${s.found ? '' : 'border-dashed'}`}
              >
                {i + 1}
              </button>
            )
          })}
        </div>
      ) : null}

      {/* Pick mode: outline under the pointer + a banner. */}
      {picking ? (
        <>
          {hover ? (
            <div
              aria-hidden
              className="pointer-events-none fixed z-40 rounded-sm border-2 border-accent bg-accent/5"
              style={{ left: hover.left - 2, top: hover.top - 2, width: hover.width + 4, height: hover.height + 4 }}
            />
          ) : null}
          <div {...ui} role="status" className="fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-3 border-b border-accent bg-accent-soft px-4 py-2.5 text-[13px] text-ink print:hidden">
            <span>Tap anything on the page to pin a comment to it.</span>
            <button type="button" onClick={() => setPicking(false)} className="rounded-md border border-line bg-surface px-2.5 py-1 text-[12px] font-medium text-ink hover:border-ink-faint">
              Cancel
            </button>
          </div>
        </>
      ) : null}

      {/* The comment box at the pin (a bottom sheet on a phone). */}
      {open ? (
        <Composer
          key={open.client_id}
          pin={open}
          spot={openSpot}
          narrow={narrow}
          recipients={recipients}
          saveState={saveState[open.client_id] ?? (open.unsynced ? 'local' : 'saved')}
          busy={busy}
          readOnly={readOnly}
          onEdit={(patch) => edit(open.client_id, patch)}
          onClose={() => {
            // A pin closed before anything was written is not worth keeping.
            if (open.status === 'draft' && !open.body.trim() && !open.tag) return void discard(open.client_id)
            if (timers.current[open.client_id]) void saveNow(open.client_id)
            setOpenId(null)
          }}
          onSend={() => void send([open.client_id])}
          onDiscard={() => void discard(open.client_id)}
          onReply={(body) => reply(open, body)}
          onResolve={(r) => void resolve(open, r)}
        />
      ) : null}

      {/* "My comments" tray. */}
      {trayOpen ? (
        <div
          {...ui}
          role="dialog"
          aria-label="My comments"
          className="fixed inset-x-0 bottom-0 z-50 flex max-h-[78vh] flex-col rounded-t-xl border border-line bg-surface shadow-lg sm:inset-x-auto sm:bottom-20 sm:right-4 sm:max-h-[70vh] sm:w-[380px] sm:rounded-xl print:hidden"
        >
          <div className="flex items-center justify-between border-b border-line-soft px-4 py-3">
            <h2 className="text-[14px] font-semibold text-ink">My comments</h2>
            <button type="button" onClick={() => setTrayOpen(false)} className="rounded-md px-2 py-1 text-[12px] text-ink-muted hover:text-ink">
              Close
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line-soft px-4 py-2 text-[12px] text-ink-muted">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={showPins}
                onChange={(e) => {
                  setShowPins(e.target.checked)
                  try {
                    storage()?.setItem(PREFS_KEY, JSON.stringify({ showPins: e.target.checked }))
                  } catch {
                    /* fine */
                  }
                }}
              />
              Show pins on pages
            </label>
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
              Show resolved{resolvedCount ? ` (${resolvedCount})` : ''}
            </label>
          </div>
          {notice ? <p className="border-b border-line-soft bg-canvas px-4 py-2 text-[12px] text-ink">{notice}</p> : null}
          <div className="min-h-0 flex-1 overflow-y-auto">
            <section className="px-4 py-3">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-[12px] font-semibold uppercase tracking-[0.04em] text-ink-muted">Drafts ({drafts.length})</h3>
                {drafts.length > 1 ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void send(drafts.map((d) => d.client_id))}
                    className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-soft disabled:opacity-50"
                  >
                    Send all {drafts.length}
                  </button>
                ) : null}
              </div>
              {drafts.length === 0 ? <p className="text-[12px] text-ink-faint">No drafts. Tap Comment, then tap anything on a page.</p> : null}
              <ul className="space-y-1.5">
                {drafts.map((p) => (
                  <li key={p.client_id} className="flex items-start gap-2 rounded-md border border-line-soft px-2.5 py-2">
                    <button type="button" onClick={() => goTo(p)} className="min-w-0 flex-1 text-left">
                      <span className="block truncate text-[13px] text-ink">{p.body.trim() ? p.body : <em className="text-ink-faint">Empty draft</em>}</span>
                      <span className="block truncate text-[11px] text-ink-faint">
                        {pinLabel(p)} · to {p.recipient_name} · <span suppressHydrationWarning>{when(p.updated_at)}</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={busy || !p.body.trim()}
                      onClick={() => void send([p.client_id])}
                      className="shrink-0 rounded-md border border-line px-2 py-1 text-[12px] font-medium text-accent disabled:opacity-40"
                    >
                      Send
                    </button>
                  </li>
                ))}
              </ul>
            </section>
            <section className="border-t border-line-soft px-4 py-3">
              <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.04em] text-ink-muted">Sent ({sentPins.length})</h3>
              {sentPins.length === 0 ? <p className="text-[12px] text-ink-faint">Nothing sent yet.</p> : null}
              <ul className="space-y-1.5">
                {sentPins.map((p) => (
                  <li key={p.client_id}>
                    <button type="button" onClick={() => goTo(p)} className="w-full rounded-md border border-line-soft px-2.5 py-2 text-left hover:border-line">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[13px] text-ink">{p.body}</span>
                        <span className={`shrink-0 text-[11px] font-medium ${STATUS_CLS[p.status]}`}>{STATUS_LABEL[p.status]}</span>
                      </span>
                      <span className="block truncate text-[11px] text-ink-faint">
                        {pinLabel(p)} · to {p.recipient_name} · <span suppressHydrationWarning>{when(p.sent_at)}</span>
                        {p.replies.length ? ` · ${p.replies.length} repl${p.replies.length === 1 ? 'y' : 'ies'}` : ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      ) : null}

      {/* Floating buttons. Hidden while the phone nav drawer is open (AppNav sets
          data-nav-menu-open on <html>), so the pill never draws over the drawer. */}
      <div
        {...ui}
        className="fixed bottom-4 right-4 z-50 flex items-center gap-2 print:hidden [html[data-nav-menu-open]_&]:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <button
          type="button"
          onClick={() => setTrayOpen((t) => !t)}
          aria-label={drafts.length ? `My comments, ${drafts.length} draft${drafts.length === 1 ? '' : 's'}` : 'My comments'}
          className="relative rounded-full border border-line bg-surface px-3.5 py-2 text-[13px] text-ink shadow-sm hover:border-ink-faint"
        >
          My comments
          {drafts.length ? (
            <span className="ml-1.5 inline-flex min-w-[18px] items-center justify-center rounded-full bg-warn px-1 text-[11px] font-semibold tabular-nums text-warn-soft">
              {drafts.length}
            </span>
          ) : null}
        </button>
        {readOnly ? (
          <span className="rounded-full border border-line-soft bg-surface px-3 py-2 text-[12px] text-ink-muted shadow-sm">{VIEW_ONLY_NOTE}</span>
        ) : (
          <button
            type="button"
            onClick={() => {
              setOpenId(null)
              setTrayOpen(false)
              setPicking((x) => !x)
            }}
            aria-pressed={picking}
            className="rounded-full bg-accent px-4 py-2 text-[13px] font-medium text-accent-soft shadow-sm hover:opacity-95"
          >
            {picking ? 'Cancel' : 'Comment'}
          </button>
        )}
      </div>
    </>
  )
}

// ------------------------------------------------------------------ the comment box

function Composer({
  pin, spot, narrow, recipients, saveState, busy, readOnly = false, onEdit, onClose, onSend, onDiscard, onReply, onResolve,
}: {
  pin: Pin
  spot: PinSpot | null
  narrow: boolean
  recipients: { id: string; display_name: string }[]
  saveState: SaveState
  busy: boolean
  readOnly?: boolean
  onEdit: (patch: Partial<Pick<Pin, 'body' | 'recipient' | 'tag'>>) => void
  onClose: () => void
  onSend: () => void
  onDiscard: () => void
  onReply: (body: string) => Promise<boolean>
  onResolve: (resolved: boolean) => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [replyText, setReplyText] = useState(() => loadReply(storage(), pin.client_id))
  const isDraft = pin.status === 'draft'
  const ui = { [UI_ATTR]: '' }

  // Desktop: a card next to the pin. Phone (or no spot): a sheet at the bottom of the screen.
  const sheet = narrow || !spot
  const width = 340
  const style = sheet
    ? undefined
    : { left: Math.max(8, Math.min(spot!.x + 16, (typeof window !== 'undefined' ? window.scrollX + window.innerWidth : 1200) - width - 8)), top: spot!.y + 8, width }

  return (
    <div
      {...ui}
      role="dialog"
      aria-label={isDraft ? 'New comment' : 'Comment'}
      style={style}
      className={`${sheet ? 'fixed inset-x-0 bottom-0 max-h-[80vh] rounded-t-xl' : 'absolute rounded-xl'} z-50 flex flex-col overflow-hidden border border-line bg-surface shadow-lg print:hidden`}
    >
      <div className="flex items-start justify-between gap-2 border-b border-line-soft px-3.5 py-2.5">
        <div className="min-w-0">
          <p className="truncate text-[12px] text-ink-muted">
            On {pin.anchor_label ?? 'this spot'}
            {pin.anchor_text ? <span className="text-ink-faint"> · “{pin.anchor_text.slice(0, 60)}”</span> : null}
          </p>
          <p className={`text-[11px] font-medium ${STATUS_CLS[pin.status]}`}>
            {STATUS_LABEL[pin.status]}
            {!isDraft ? <span className="font-normal text-ink-faint"> · to {pin.recipient_name} · <span suppressHydrationWarning>{when(pin.sent_at)}</span>{pin.delivery === 'failed' ? ' · delivery failed' : ''}</span> : null}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 rounded-md px-1.5 py-0.5 text-[16px] leading-none text-ink-muted hover:text-ink">
          ×
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {isDraft ? (
          <>
            <label className="sr-only" htmlFor={`c-${pin.client_id}`}>
              Comment
            </label>
            <textarea
              id={`c-${pin.client_id}`}
              autoFocus
              rows={4}
              value={pin.body}
              onChange={(e) => onEdit({ body: e.target.value })}
              placeholder="What should change here?"
              className="w-full resize-y rounded-md border border-line bg-canvas px-2.5 py-2 text-[14px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-muted"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1.5 text-[12px] text-ink-muted">
                To
                <select
                  value={pin.recipient}
                  onChange={(e) => onEdit({ recipient: e.target.value })}
                  className="rounded-md border border-line bg-surface px-1.5 py-1 text-[12px] text-ink"
                >
                  {recipients.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.display_name}
                    </option>
                  ))}
                </select>
              </label>
              <div role="group" aria-label="Tag" className="flex gap-1">
                {TAG_OPTIONS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={pin.tag === t.id}
                    onClick={() => onEdit({ tag: pin.tag === t.id ? null : t.id })}
                    className={`rounded-full border px-2 py-0.5 text-[11px] ${pin.tag === t.id ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink-muted hover:text-ink'}`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : (
          <>
            <p className="whitespace-pre-wrap text-[14px] text-ink">{pin.body}</p>
            {pin.replies.length ? (
              <ol className="mt-3 space-y-2 border-t border-line-soft pt-3">
                {pin.replies.map((r) => (
                  <li key={r.id} className={r.author_kind === 'agent' ? 'rounded-md bg-accent-soft px-2.5 py-2' : 'px-2.5'}>
                    <p className="text-[11px] text-ink-muted">
                      <span className="font-medium text-ink">{r.author_name}</span> · <span suppressHydrationWarning>{when(r.created_at)}</span>
                    </p>
                    <p className="whitespace-pre-wrap text-[13px] text-ink">{r.body}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-2 text-[12px] text-ink-faint">{pin.status === 'seen' ? `${pin.recipient_name} has seen it.` : `Waiting for ${pin.recipient_name}.`}</p>
            )}
            {readOnly ? null : (
            <>
            <label className="sr-only" htmlFor={`r-${pin.client_id}`}>
              Reply
            </label>
            <textarea
              id={`r-${pin.client_id}`}
              rows={2}
              value={replyText}
              onChange={(e) => {
                setReplyText(e.target.value)
                putReply(storage(), pin.client_id, e.target.value)
              }}
              placeholder={pin.status === 'resolved' ? 'Reply to reopen…' : 'Reply…'}
              className="mt-3 w-full resize-y rounded-md border border-line bg-canvas px-2.5 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-muted"
            />
            </>
            )}
          </>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-line-soft px-3.5 py-2.5" style={sheet ? { paddingBottom: 'calc(0.625rem + env(safe-area-inset-bottom))' } : undefined}>
        {isDraft ? (
          <>
            <span className="text-[11px] text-ink-faint" aria-live="polite">
              {saveState === 'saving' ? 'Saving…' : saveState === 'local' ? 'Saved on this device' : saveState === 'error' ? 'Not saved' : 'Draft saved'}
            </span>
            <div className="flex items-center gap-1.5">
              {confirmDelete ? (
                <>
                  <button type="button" onClick={onDiscard} className="rounded-md px-2 py-1 text-[12px] font-medium text-bad">
                    Delete draft
                  </button>
                  <button type="button" onClick={() => setConfirmDelete(false)} className="rounded-md px-2 py-1 text-[12px] text-ink-muted">
                    Keep
                  </button>
                </>
              ) : (
                <>
                  <button type="button" onClick={() => setConfirmDelete(true)} className="rounded-md px-2 py-1 text-[12px] text-ink-muted hover:text-bad">
                    Delete
                  </button>
                  <button type="button" onClick={onClose} className="rounded-md border border-line px-2.5 py-1 text-[12px] text-ink">
                    Later
                  </button>
                  <button
                    type="button"
                    disabled={busy || !pin.body.trim()}
                    onClick={onSend}
                    className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-soft disabled:opacity-50"
                  >
                    Send to {pin.recipient_name}
                  </button>
                </>
              )}
            </div>
          </>
        ) : readOnly ? (
          <span className="text-[11px] text-ink-faint">{VIEW_ONLY_NOTE}</span>
        ) : (
          <>
            <button type="button" onClick={() => onResolve(pin.status !== 'resolved')} className="rounded-md px-2 py-1 text-[12px] text-ink-muted hover:text-ink">
              {pin.status === 'resolved' ? 'Reopen' : 'Mark resolved'}
            </button>
            <button
              type="button"
              disabled={busy || !replyText.trim() || !pin.id}
              onClick={async () => {
                if (await onReply(replyText)) {
                  setReplyText('')
                  putReply(storage(), pin.client_id, '')
                }
              }}
              className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-accent-soft disabled:opacity-50"
            >
              Reply
            </button>
          </>
        )}
      </div>
    </div>
  )
}
