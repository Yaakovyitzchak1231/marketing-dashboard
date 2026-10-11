'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { liveConnected, subscribeLive } from './live'

/**
 * Re-read the server data the moment something changes (live stream on /api/live),
 * with a slow timer as a fallback when the stream is unavailable.
 *
 * - on="reply": only a newly stored Instantly reply triggers a re-read (pages whose
 *   numbers come from Instantly, not from the lead database).
 * - poll="always": the timer re-reads every `seconds` while the tab is visible, even
 *   with the stream connected (data the stream cannot see, like Instantly's own counts).
 */
export function AutoRefresh({
  seconds = 15,
  on = 'any',
  poll = 'fallback',
}: {
  seconds?: number
  on?: 'any' | 'reply'
  poll?: 'fallback' | 'always'
}) {
  const router = useRouter()
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    // The webhook clears the Instantly cache right after storing a reply; give it a moment.
    const delay = on === 'reply' ? 2000 : 250
    const refresh = () => {
      if (pending.current) clearTimeout(pending.current)
      pending.current = setTimeout(() => router.refresh(), delay)
    }
    let seenReply: number | null | undefined
    const unsubscribe = subscribeLive((c) => {
      if (on === 'reply') {
        const before = seenReply
        seenReply = c.last_reply_id
        if (before !== undefined && c.last_reply_id !== before) refresh()
        return
      }
      if (c.first) return
      refresh()
    })
    const t = setInterval(() => {
      if (document.visibilityState === 'visible' && (poll === 'always' || !liveConnected())) router.refresh()
    }, seconds * 1000)
    return () => {
      unsubscribe()
      clearInterval(t)
      if (pending.current) clearTimeout(pending.current)
    }
  }, [router, seconds, on, poll])
  return null
}
