import type { Role } from '@/lib/auth/roles'
import { VIEWER_REFUSAL } from './useRole'

/**
 * What Next 15's client runtime throws when a server action's POST comes back
 * as a non-text/plain error (middleware answers a viewer's write with a 403
 * JSON body, so the action reducer cannot read our words and throws this).
 * Source: next/dist/client/components/router-reducer/reducers/server-action-reducer.js
 */
export const NEXT_UNEXPECTED_ACTION_RESPONSE = 'An unexpected response was received from the server.'

export const VIEW_ONLY_TOAST = 'View-only access: viewers can look but not change things'

/** Only for a real network failure or a 5xx with no words of its own. */
export const COULD_NOT_REACH = 'Couldn\u2019t reach the server.'

/** The event ViewOnlyGuard listens for to show VIEW_ONLY_TOAST. */
export const VIEW_ONLY_EVENT = 'tapdash:view-only'

/**
 * Ask the mounted ViewOnlyGuard to show its calm view-only note (e.g. a viewer
 * clicked a value that would open an inline editor). No-op on the server.
 */
export function announceViewOnly(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(VIEW_ONLY_EVENT))
}

/** Props that mark a control as view-only the same way ViewOnlyGuard marks form buttons. */
export const VIEW_ONLY_PROPS = { 'aria-disabled': true, title: 'View-only access' } as const
export const VIEW_ONLY_DIM = 'opacity-50 cursor-not-allowed'

/**
 * The words for a write (fetch) that came back not-ok:
 * - 403 that is the viewer refusal (or any 403 with no words, or any 403 while
 *   we know the person is a viewer) -> the calm view-only note;
 * - the server's own words when it sent some;
 * - a 5xx with no words -> "Couldn't reach the server.";
 * - otherwise the caller's fallback (usually "... (status)").
 */
export function failedWriteText(
  status: number,
  serverError: unknown,
  fallback: string,
  role?: Role | null,
): string {
  const err = typeof serverError === 'string' ? serverError.trim() : ''
  if (status === 403 && (!err || err.includes(VIEWER_REFUSAL) || role === 'viewer')) return VIEW_ONLY_TOAST
  if (err) return err
  if (status >= 500) return COULD_NOT_REACH
  return fallback
}

/**
 * The words for a write that threw (a server action whose POST the middleware
 * refused, or a fetch that never got an answer): the view-only note when it is
 * the viewer gate, else "Couldn't reach the server." plus an optional suffix.
 */
export function thrownWriteText(reason: unknown, role: Role | null | undefined, suffix = ''): string {
  if (isViewerRefusal(reason, role)) return VIEW_ONLY_TOAST
  return suffix ? `${COULD_NOT_REACH} ${suffix}` : COULD_NOT_REACH
}

function messageOf(reason: unknown): string {
  if (typeof reason === 'string') return reason
  if (reason && typeof reason === 'object' && 'message' in reason) {
    const m = (reason as { message?: unknown }).message
    return typeof m === 'string' ? m : ''
  }
  return ''
}

/**
 * True when an error is the viewer write gate refusing, not a real failure.
 * Our own words always count. Next's generic "unexpected response" (or a bare
 * 403) only counts when we know the person is a viewer, so a real outage for
 * an editor or owner still shows the real error.
 */
export function isViewerRefusal(reason: unknown, role: string | null | undefined): boolean {
  const msg = messageOf(reason)
  if (!msg) return false
  if (msg.includes(VIEWER_REFUSAL)) return true
  if (role !== 'viewer') return false
  return msg === NEXT_UNEXPECTED_ACTION_RESPONSE || /\b403\b/.test(msg)
}

/**
 * A form that writes when submitted: a server-action form as React 19 renders
 * it (SSR: method=POST + a hidden $ACTION_ field; client: a javascript: action
 * placeholder), or any plain POST. GET forms (search, filters) never count.
 * A form marked data-write (a client form that writes over fetch) counts.
 * A form (or an ancestor) marked data-viewer-ok is left alone.
 */
export function isWriteForm(form: HTMLFormElement, submitter?: Element | null): boolean {
  if (form.closest('[data-viewer-ok]')) return false
  // A client-side form that writes over fetch (onSubmit + PATCH/POST) says so.
  if (form.hasAttribute('data-write')) return true
  const sub = submitter instanceof HTMLElement ? submitter : null
  const method = (sub?.getAttribute('formmethod') || form.getAttribute('method') || '').toLowerCase()
  const action = (sub?.getAttribute('formaction') || form.getAttribute('action') || '').trim().toLowerCase()
  if (method === 'post') return true
  if (method === 'dialog') return false
  if (action.startsWith('javascript:')) return true
  return form.querySelector('input[name^="$ACTION_"]') !== null
}

/** The buttons that would submit a form (default-type buttons included). */
export function submitButtonsOf(form: HTMLFormElement): HTMLElement[] {
  const inside = Array.from(form.querySelectorAll<HTMLElement>('button, input[type="submit"], input[type="image"]'))
  const outside = form.id
    ? Array.from(document.querySelectorAll<HTMLElement>(`[form="${CSS.escape(form.id)}"]`))
    : []
  return [...inside, ...outside].filter((el) => {
    if (el instanceof HTMLButtonElement) return el.type === 'submit'
    return true
  })
}
