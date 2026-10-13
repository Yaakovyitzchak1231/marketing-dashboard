'use client'

import { useState } from 'react'
import type { SourceError } from '@/lib/dashboard/types'

const SOURCE_NAMES: Record<string, string> = {
  campaigns: 'campaign list',
  'campaigns/analytics': 'campaign numbers',
  'campaigns/analytics/overview': 'overall totals',
  'campaigns/analytics/daily': 'daily chart',
  'campaigns/analytics/steps': 'per-step results',
  accounts: 'sending accounts',
  'accounts/analytics/daily': 'per-inbox sends and bounces',
  emails: 'replies',
  leads: 'leads',
}

export function sourceName(source: string): string {
  if (SOURCE_NAMES[source]) return SOURCE_NAMES[source]
  const base = Object.keys(SOURCE_NAMES)
    .filter((k) => source.startsWith(k))
    .sort((a, b) => b.length - a.length)[0]
  return base ? SOURCE_NAMES[base] : source
}

/** Partial failures: shown, never hidden. Dismissible for this page view only. */
export function ErrorsNotice({ errors }: { errors: SourceError[] }) {
  const [dismissed, setDismissed] = useState(false)
  if (errors.length === 0 || dismissed) return null
  return (
    <div role="status" className="flex items-start gap-3 rounded-card border border-warn/30 bg-warn-soft px-4 py-3 text-sm" data-testid="errors-notice">
      <div className="min-w-0 flex-1">
        <p className="font-medium text-warn">
          Some numbers could not be loaded from Instantly, so parts of this page are incomplete.
        </p>
        <ul className="mt-1 space-y-0.5 text-ink-muted">
          {errors.map((e, idx) => (
            <li key={`${e.source}-${idx}`}>
              <span className="font-medium text-ink">{sourceName(e.source)}</span>: {e.message}
            </li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        className="shrink-0 rounded px-1.5 text-lg leading-none text-ink-faint hover:text-ink"
        aria-label="Dismiss"
      >
        ×
      </button>
    </div>
  )
}
