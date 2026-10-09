/**
 * The browser's own copy of every comment draft, so nothing is lost even when the network or the
 * database is not there: written on every keystroke, merged with the server's rows on load.
 */
import type { CommentStatus, DraftInput, PageCommentView } from './core.ts'

export const STORE_KEY = 'tapdash.pageComments.v1'
export const REPLY_KEY = 'tapdash.pageComments.replies.v1'

export interface LocalDraft extends DraftInput {
  client_id: string
  /** ms since epoch of the last edit on this device */
  updated_at: number
  /** the updated_at value the server last confirmed; null = never saved to the server */
  synced_at: number | null
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>

function readJson<T>(s: Storage | null | undefined, key: string): T | null {
  if (!s) return null
  try {
    const raw = s.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}
function writeJson(s: Storage | null | undefined, key: string, v: unknown): boolean {
  if (!s) return false
  try {
    s.setItem(key, JSON.stringify(v))
    return true
  } catch {
    return false
  }
}

export function loadLocal(s: Storage | null | undefined): Record<string, LocalDraft> {
  const v = readJson<Record<string, LocalDraft>>(s, STORE_KEY)
  if (!v || typeof v !== 'object') return {}
  const out: Record<string, LocalDraft> = {}
  for (const [k, d] of Object.entries(v)) if (d && typeof d === 'object' && d.client_id === k && typeof d.page_path === 'string') out[k] = d
  return out
}
export function putLocal(s: Storage | null | undefined, d: LocalDraft): boolean {
  const all = loadLocal(s)
  all[d.client_id] = d
  return writeJson(s, STORE_KEY, all)
}
export function removeLocal(s: Storage | null | undefined, clientId: string): void {
  const all = loadLocal(s)
  if (clientId in all) {
    delete all[clientId]
    writeJson(s, STORE_KEY, all)
  }
}

export function loadReply(s: Storage | null | undefined, clientId: string): string {
  return readJson<Record<string, string>>(s, REPLY_KEY)?.[clientId] ?? ''
}
export function putReply(s: Storage | null | undefined, clientId: string, text: string): void {
  const all = readJson<Record<string, string>>(s, REPLY_KEY) ?? {}
  if (text) all[clientId] = text
  else delete all[clientId]
  writeJson(s, REPLY_KEY, all)
}

export function newClientId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '')
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
}

/** A comment as the layer shows it: a server row, or a draft only this device knows yet (id null). */
export interface Pin extends Omit<PageCommentView, 'id'> {
  id: number | null
  /** edits on this device not yet confirmed by the server */
  unsynced: boolean
}

export function localToPin(d: LocalDraft, recipientName: (id: string) => string): Pin {
  const now = new Date(d.updated_at).toISOString()
  const recipient = (d.recipient || 'tab').toLowerCase()
  return {
    id: null,
    client_id: d.client_id,
    author: 'owner',
    recipient,
    recipient_name: recipientName(recipient),
    page_path: d.page_path,
    page_title: d.page_title ?? null,
    selector: d.selector ?? null,
    anchor_label: d.anchor_label ?? null,
    anchor_text: d.anchor_text ?? null,
    off_x: d.off_x ?? null,
    off_y: d.off_y ?? null,
    x_pct: d.x_pct ?? null,
    y_pct: d.y_pct ?? null,
    body: d.body ?? '',
    tag: (d.tag as Pin['tag']) ?? null,
    status: 'draft' as CommentStatus,
    delivery: null,
    delivery_error: null,
    sent_at: null,
    seen_at: null,
    resolved_at: null,
    created_at: now,
    updated_at: now,
    replies: [],
    unsynced: true,
  }
}

export function pinToLocal(p: Pin, updatedAt: number, syncedAt: number | null): LocalDraft {
  return {
    client_id: p.client_id,
    recipient: p.recipient,
    page_path: p.page_path,
    page_title: p.page_title,
    selector: p.selector,
    anchor_label: p.anchor_label,
    anchor_text: p.anchor_text,
    off_x: p.off_x,
    off_y: p.off_y,
    x_pct: p.x_pct,
    y_pct: p.y_pct,
    body: p.body,
    tag: p.tag,
    updated_at: updatedAt,
    synced_at: syncedAt,
  }
}

/**
 * Server rows + this device's drafts -> one list. A local draft with edits the server has not
 * confirmed wins over the server's copy (and is pushed again); a comment the server says was sent
 * drops its local copy.
 */
export function merge(
  server: PageCommentView[],
  local: Record<string, LocalDraft>,
  recipientName: (id: string) => string,
): { pins: Pin[]; push: LocalDraft[]; drop: string[] } {
  const pins: Pin[] = []
  const push: LocalDraft[] = []
  const drop: string[] = []
  const seen = new Set<string>()
  for (const s of server) {
    seen.add(s.client_id)
    const l = local[s.client_id]
    if (s.status !== 'draft') {
      if (l) drop.push(s.client_id)
      pins.push({ ...s, unsynced: false })
      continue
    }
    if (l && (l.synced_at == null || l.updated_at > l.synced_at)) {
      const p = localToPin(l, recipientName)
      pins.push({ ...p, id: s.id, created_at: s.created_at })
      push.push(l)
    } else {
      pins.push({ ...s, unsynced: false })
    }
  }
  for (const l of Object.values(local)) {
    if (seen.has(l.client_id)) continue
    // Never on the server: either it was never saved there, or it was sent/discarded elsewhere.
    // A draft that was confirmed once and is now missing was discarded on another device: drop it.
    if (l.synced_at != null && l.updated_at <= l.synced_at) {
      drop.push(l.client_id)
      continue
    }
    pins.push(localToPin(l, recipientName))
    push.push(l)
  }
  pins.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
  return { pins, push, drop }
}

/** Which pins belong on this page (path match, query string ignored). */
export function onPage(p: { page_path: string }, pathname: string): boolean {
  const path = p.page_path.split('?')[0].split('#')[0]
  return path === pathname
}
