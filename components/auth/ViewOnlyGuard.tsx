'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRole } from './useRole'
import { VIEW_ONLY_TOAST, isViewerRefusal, isWriteForm, submitButtonsOf } from './viewOnly'

const MARK = 'data-view-only-disabled'
const DIM = ['opacity-50', 'cursor-not-allowed']

/**
 * For viewers only: stops write forms before they post (the server would
 * refuse them anyway), marks their submit buttons as view-only, and turns a
 * refused write that slipped through (a click handler calling a server
 * action) into a short, calm note instead of silence.
 *
 * UI only. middleware.ts stays the gate; nothing here grants or removes access.
 * Mount once, in app/layout.tsx: <ViewOnlyGuard />
 */
export function ViewOnlyGuard() {
  const role = useRole()
  const [toast, setToast] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = useCallback(() => {
    setToast(VIEW_ONLY_TOAST)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setToast(null), 4000)
  }, [])

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  useEffect(() => {
    if (role !== 'viewer') return
    const html = document.documentElement
    html.setAttribute('data-view-only', '')

    const onSubmit = (e: SubmitEvent) => {
      const form = e.target
      if (!(form instanceof HTMLFormElement)) return
      if (!isWriteForm(form, e.submitter)) return
      e.preventDefault()
      e.stopImmediatePropagation()
      show()
    }

    const onRejection = (e: PromiseRejectionEvent) => {
      if (!isViewerRefusal(e.reason, 'viewer')) return
      e.preventDefault()
      show()
    }

    const mark = () => {
      document.querySelectorAll('form').forEach((form) => {
        if (!isWriteForm(form)) return
        for (const btn of submitButtonsOf(form)) {
          if (btn.hasAttribute(MARK)) continue
          btn.setAttribute(MARK, '')
          btn.setAttribute('aria-disabled', 'true')
          btn.setAttribute('title', 'View-only access')
          btn.classList.add(...DIM)
        }
      })
    }

    mark()
    const observer = new MutationObserver(mark)
    observer.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('submit', onSubmit, true)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      observer.disconnect()
      window.removeEventListener('submit', onSubmit, true)
      window.removeEventListener('unhandledrejection', onRejection)
      html.removeAttribute('data-view-only')
      document.querySelectorAll(`[${MARK}]`).forEach((btn) => {
        btn.removeAttribute(MARK)
        btn.removeAttribute('aria-disabled')
        btn.removeAttribute('title')
        btn.classList.remove(...DIM)
      })
    }
  }, [role, show])

  if (!toast) return null
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex justify-center px-4 sm:bottom-6 print:hidden"
    >
      <p className="max-w-[420px] rounded-card border border-line bg-surface px-4 py-2.5 text-[13px] text-ink shadow-card">
        {toast}
      </p>
    </div>
  )
}

export default ViewOnlyGuard
