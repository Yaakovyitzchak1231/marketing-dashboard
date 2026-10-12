import { VIEWER_REFUSAL } from './useRole'

/**
 * What Next 15's client runtime throws when a server action's POST comes back
 * as a non-text/plain error (middleware answers a viewer's write with a 403
 * JSON body, so the action reducer cannot read our words and throws this).
 * Source: next/dist/client/components/router-reducer/reducers/server-action-reducer.js
 */
export const NEXT_UNEXPECTED_ACTION_RESPONSE = 'An unexpected response was received from the server.'

export const VIEW_ONLY_TOAST = 'View-only access: viewers can look but not change things'

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
 * A form (or an ancestor) marked data-viewer-ok is left alone.
 */
export function isWriteForm(form: HTMLFormElement, submitter?: Element | null): boolean {
  if (form.closest('[data-viewer-ok]')) return false
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
