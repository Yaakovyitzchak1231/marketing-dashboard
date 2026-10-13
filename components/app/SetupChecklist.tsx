'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Card } from '@/components/dashboard/primitives'
import type { ChecklistItem } from '@/lib/setup/checklist'

const DISMISS_KEY = 'tapdash.setupChecklist.dismissed'

const STATUS_DOT: Record<ChecklistItem['status'], string> = {
  done: 'bg-good',
  open: 'bg-line-soft',
  coming_soon: 'bg-line-soft',
}

/**
 * The "get set up" checklist on Overview (plan 1.15). Shows until every item
 * is done or coming-soon, and can be dismissed early -- the dismissal is
 * remembered per browser (localStorage), not server state, so it's a true
 * "hide this for me" rather than a change anyone else's login would see.
 * It reappears if a new step becomes open again (nothing here resets it on
 * purpose beyond that).
 */
export function SetupChecklist({ items, complete }: { items: ChecklistItem[]; complete: boolean }) {
  const [dismissed, setDismissed] = useState(true) // default hidden until we know (avoids a flash before localStorage reads)

  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(DISMISS_KEY) === 'true')
    } catch {
      setDismissed(false)
    }
  }, [])

  if (complete || dismissed) return null

  const done = items.filter((i) => i.status === 'done').length
  const total = items.filter((i) => i.status !== 'coming_soon').length

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISS_KEY, 'true')
    } catch {
      // localStorage unavailable; dismiss just won't persist across reloads
    }
    setDismissed(true)
  }

  return (
    <Card className="px-4 py-3.5" data-testid="setup-checklist">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink">Get set up</p>
          <p className="text-xs text-ink-faint">
            {done} of {total} done
          </p>
        </div>
        <button type="button" onClick={dismiss} className="text-xs text-ink-faint underline hover:text-ink" data-testid="setup-checklist-dismiss">
          Dismiss
        </button>
      </div>
      <ul className="mt-2.5 space-y-1.5">
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-2 text-sm" data-testid={`setup-checklist-item-${item.id}`}>
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[item.status]}`} aria-hidden />
            {item.status === 'open' ? (
              <Link href={item.href} className="text-accent hover:underline">
                {item.label}
              </Link>
            ) : (
              <span className={item.status === 'done' ? 'text-ink-muted line-through' : 'text-ink-faint'}>
                {item.label}
                {item.status === 'coming_soon' ? ' (coming soon)' : ''}
              </span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  )
}
