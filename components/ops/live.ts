'use client'

/**
 * One shared live connection per browser tab (EventSource on /api/live). Components
 * subscribe; the connection opens while the tab is visible and closes when it is hidden.
 */
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

function open() {
  if (es || typeof window === 'undefined' || typeof EventSource === 'undefined') return
  if (document.visibilityState !== 'visible') return
  es = new EventSource('/api/live')
  es.addEventListener('change', (e) => {
    failures = 0
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
      open()
    } else close()
  })
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
