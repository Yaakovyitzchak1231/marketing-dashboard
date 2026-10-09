'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { liveConnected, subscribeLive } from './live'

/**
 * Re-read the server data the moment something changes (live stream on /api/live),
 * with a slow timer as a fallback when the stream is unavailable.
 */
export function AutoRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter()
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const unsubscribe = subscribeLive((c) => {
      if (c.first) return
      if (pending.current) clearTimeout(pending.current)
      pending.current = setTimeout(() => router.refresh(), 250)
    })
    const t = setInterval(() => {
      if (document.visibilityState === 'visible' && !liveConnected()) router.refresh()
    }, seconds * 1000)
    return () => {
      unsubscribe()
      clearInterval(t)
      if (pending.current) clearTimeout(pending.current)
    }
  }, [router, seconds])
  return null
}
