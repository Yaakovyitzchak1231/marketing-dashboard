import Link from 'next/link'
import type { LeadFilter } from '@/lib/verify/select'

/** Most ids we put in a URL; past this, pass the Leads filter instead. */
export const MAX_IDS_IN_URL = 500

/** /verify?ids=1,2,3 or /verify?state=MD&stage=new... (the /verify screen pre-fills from these). */
export function verifyHref({ contactIds, filter }: { contactIds?: number[]; filter?: LeadFilter }): string {
  const p = new URLSearchParams()
  const ids = (contactIds ?? []).filter((n) => Number.isInteger(n) && n > 0)
  if (ids.length > 0 && ids.length <= MAX_IDS_IN_URL) {
    p.set('ids', ids.join(','))
  } else if (filter) {
    for (const k of ['state', 'stage', 'verification_status', 'segment', 'q'] as const) {
      const v = filter[k]
      if (v) p.set(k, v)
    }
  }
  const qs = p.toString()
  return qs ? `/verify?${qs}` : '/verify'
}

/**
 * Drop-in for the Leads screen: links to /verify with the selection, where
 * the free check runs and the cost preview waits for an explicit approve.
 * Never spends anything by itself.
 */
export function VerifyButton({
  contactIds,
  filter,
  label = 'Verify emails',
  className = '',
}: {
  contactIds?: number[]
  filter?: LeadFilter
  label?: string
  className?: string
}) {
  const n = contactIds ? contactIds.length : 0
  return (
    <Link
      href={verifyHref({ contactIds, filter })}
      prefetch={false}
      className={`inline-flex items-center rounded-control border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-muted hover:text-ink ${className}`}
      title="Runs the free check first and shows the cost before anything paid happens"
    >
      {label}
      {n > 0 ? <span className="ml-1 tabular-nums text-ink-faint">({n.toLocaleString('en-US')})</span> : null}
    </Link>
  )
}
