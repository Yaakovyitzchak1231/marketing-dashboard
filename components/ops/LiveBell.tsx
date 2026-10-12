'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { subscribeLive } from './live'

/** The live unread count (null until the first answer). One shared connection, however many callers. */
export function useUnread(): number | null {
  const [unread, setUnread] = useState<number | null>(null)
  useEffect(() => subscribeLive((c) => setUnread(c.unread)), [])
  return unread
}

/** Unread count for Yaakov, live (screens that show live data refresh themselves via AutoRefresh). */
export function LiveBell() {
  const unread = useUnread()
  return (
    <Link
      href="/agents/owner"
      prefetch={false}
      aria-label={unread ? `${unread} unread` : 'Inbox'}
      className="relative shrink-0 rounded-md px-2 py-1.5 text-[13px] text-ink-muted hover:text-ink"
    >
      Inbox
      {unread ? (
        <span className="ml-1 inline-flex min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[11px] font-semibold tabular-nums text-accent-soft">
          {unread > 99 ? '99+' : unread}
        </span>
      ) : null}
    </Link>
  )
}
