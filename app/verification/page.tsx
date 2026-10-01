import Link from 'next/link'
import { getBaseUrl } from '@/lib/base-url'
import { formatRate } from '@/lib/format'

export const dynamic = 'force-dynamic'

type SourceRow = {
  source: string
  total: number
  verified: number
  clean: number
  dirty: number
  catch_all: number
  role_skipped: number
  unverified: number
  clean_rate: number | null
}

export default async function VerificationPage() {
  // Origin for the server-side self-fetch. The fallback port lives in
  // lib/base-url.ts so this file never carries a numeric literal.
  const base = getBaseUrl()
  const { cookies } = await import('next/headers')
  const cookie = (await cookies()).toString()

  let data: { sources: SourceRow[] } | null = null
  try {
    const res = await fetch(`${base}/api/verification`, {
      cache: 'no-store',
      headers: cookie ? { cookie } : undefined,
    })
    if (res.ok) data = await res.json()
  } catch {
    data = null
  }

  const sources = data?.sources ?? []

  return (
    <main className="mx-auto w-full max-w-shell px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-[15px] font-medium tracking-[-0.01em] text-ink">
            Lead verification
          </h1>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            Which lead source produces the cleanest verified addresses.
          </p>
        </div>
        <Link href="/" className="text-[12px] text-ink-muted underline-offset-4 hover:underline">
          Back to dashboard
        </Link>
      </header>

      {data === null ? (
        <p className="text-[13px] text-ink-faint">Verification data is unavailable right now.</p>
      ) : sources.length === 0 ? (
        <p className="text-[13px] text-ink-faint">
          No leads in the database yet. The leads collector fills this in.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-surface">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.06em] text-ink-muted">
                <th className="px-4 py-2 font-medium">Source</th>
                <th className="px-4 py-2 text-right font-medium">Leads</th>
                <th className="px-4 py-2 text-right font-medium">Verified</th>
                <th className="px-4 py-2 text-right font-medium">Clean</th>
                <th className="px-4 py-2 text-right font-medium">Dirty</th>
                <th className="px-4 py-2 text-right font-medium">Catch-all</th>
                <th className="px-4 py-2 text-right font-medium">Role-skipped</th>
                <th className="px-4 py-2 text-right font-medium">Clean rate</th>
              </tr>
            </thead>
            <tbody>
              {sources.map(s => (
                <tr key={s.source} className="border-b border-line last:border-0">
                  <td className="px-4 py-2 text-ink">{s.source}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{s.total.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{s.verified.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink">{s.clean.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{s.dirty.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{s.catch_all.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{s.role_skipped.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right tabular-nums font-medium text-ink">
                    {/* Rates are formatted in lib/format.ts; never recomputed with * 100 here. */}
                    {formatRate(s.clean_rate)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-[11px] text-ink-faint">
        Clean = valid. Dirty = invalid, spamtrap, abuse, do-not-mail. Role-skipped addresses
        were never sent to a verifier, per policy.
      </p>
    </main>
  )
}
