import Link from 'next/link'
import { getBaseUrl } from '@/lib/base-url'
import { COPY } from '@/lib/copy'
import { PERFORMANCE_RANGE, PERFORMANCE_RANGE_LABEL } from '@/lib/range'
import { FunnelTable, FunnelRow } from '@/components/funnel-manager'

export const dynamic = 'force-dynamic'

export default async function FunnelPage() {
  // Origin for the server-side self-fetch. The fallback port lives in
  // lib/base-url.ts so this file never carries a numeric literal.
  const base = getBaseUrl()
  const { cookies } = await import('next/headers')
  const cookie = (await cookies()).toString()

  let data: { campaigns: FunnelRow[]; ideas: FunnelRow[] } | null = null
  try {
    // PERFORMANCE_RANGE is the window this view reports over. Inlining `30d`
    // would put a number in the render path that no query produced.
    const res = await fetch(`${base}/api/funnel?range=${PERFORMANCE_RANGE}`, {
      cache: 'no-store',
      headers: cookie ? { cookie } : undefined,
    })
    if (res.ok) data = await res.json()
  } catch {
    data = null
  }

  return (
    <main className="mx-auto w-full max-w-shell px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-[15px] font-medium tracking-[-0.01em] text-ink">{COPY.funnel.title}</h1>
            <p className="mt-0.5 text-[11px] text-ink-faint">
              Contacted → human replies → opportunities. Meetings and customers are not reported by the source. {PERFORMANCE_RANGE_LABEL}.
            </p>
        </div>
        <Link href="/" className="text-[12px] text-ink-muted underline-offset-4 hover:underline">
          Back to dashboard
        </Link>
      </header>

      {data === null ? (
        <p className="text-[13px] text-ink-faint">{COPY.funnel.unavailable}</p>
      ) : (
        <div className="space-y-8">
          <section>
            <h2 className="mb-3 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-muted">
              {COPY.funnel.byIdea}
            </h2>
            <FunnelTable rows={data.ideas} label="Idea" />
          </section>
          <section>
            <h2 className="mb-3 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-muted">
              {COPY.funnel.byCampaign}
            </h2>
            <FunnelTable rows={data.campaigns} label="Campaign" />
          </section>
        </div>
      )}
    </main>
  )
}
