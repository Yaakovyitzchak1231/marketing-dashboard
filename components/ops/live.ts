'use client'

/**
 * One shared live connection per browser tab (EventSource on /api/live). Components
 * subscribe; the connection opens while the tab is visible and closes when it is hidden,
 * or after 15 minutes with no change and no input from the person (it resumes on focus,
 * click, key or scroll), so an idle tab does not keep the server and database awake.
 */
export const IDLE_MS = 15 * 60_000
export interface LiveChange {
  unread: number
  last_event_id: number | null
  first: boolean
}
type Listener = (c: LiveChange) => void

const listeners = new Set<Listener>()
let es: EventSource | null = null
let lastChange: LiveChange | null = null
let failures = 0
let lastActive = Date.now()
let idleTimer: ReturnType<typeof setInterval> | null = null

function markActive() {
  lastActive = Date.now()
  if (!es && listeners.size) open()
}

function open() {
  if (es || typeof window === 'undefined' || typeof EventSource === 'undefined') return
  if (document.visibilityState !== 'visible') return
  lastActive = Date.now()
  es = new EventSource('/api/live')
  es.addEventListener('change', (e) => {
    failures = 0
    lastActive = Date.now()
    try {
      lastChange = JSON.parse((e as MessageEvent).data) as LiveChange
      for (const l of listeners) l(lastChange)
    } catch {
      /* ignore */
    }
  })
  es.onerror = () => {
    failures++
    // EventSource reconnects by itself; after repeated failures stop and let the fallback timer work.
    if (failures > 5) close()
  }
}

function close() {
  es?.close()
  es = null
}

let wired = false
function wire() {
  if (wired || typeof document === 'undefined') return
  wired = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      failures = 0
      markActive()
    } else close()
  })
  for (const ev of ['focus', 'pointerdown', 'keydown', 'scroll'] as const) {
    window.addEventListener(ev, markActive, { passive: true })
  }
  if (!idleTimer) idleTimer = setInterval(() => {
    if (es && Date.now() - lastActive > IDLE_MS) close()
  }, 60_000)
}

export function subscribeLive(l: Listener): () => void {
  wire()
  listeners.add(l)
  if (lastChange) l({ ...lastChange, first: true })
  open()
  return () => {
    listeners.delete(l)
    if (!listeners.size) close()
  }
}

export function liveConnected(): boolean {
  return Boolean(es && es.readyState !== 2)
}
