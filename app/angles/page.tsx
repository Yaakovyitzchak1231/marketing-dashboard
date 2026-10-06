import { AngleManager } from '@/components/angle-manager'
import { ArtifactProvenance } from '@/components/artifact-provenance'
import { getBaseUrl, getOwnerEmail } from '@/lib/base-url'
import { PERFORMANCE_RANGE } from '@/lib/range'

import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function AnglesPage() {
  // Origin for the server-side self-fetch. The fallback port lives in
  // lib/base-url.ts so this file never carries a numeric literal.
  const base = getBaseUrl()
  const { cookies } = await import('next/headers')
  const cookie = (await cookies()).toString()

  const fetchJson = async (url: string) => {
    try {
      const res = await fetch(url, { cache: 'no-store', headers: cookie ? { cookie } : undefined })
      if (!res.ok) return null
      return await res.json()
    } catch {
      return null
    }
  }

  // PERFORMANCE_RANGE is the window these views report over. Inlining `30d`
  // would put a number in the render path that no query produced, and the
  // title could drift from the fetch.
  const [angles, performance, campaigns] = await Promise.all([
    fetchJson(`${base}/api/angles`),
    fetchJson(`${base}/api/angles/performance?range=${PERFORMANCE_RANGE}`),
    fetchJson(`${base}/api/campaigns?range=${PERFORMANCE_RANGE}`),
  ])

  return (
    <main className="mx-auto w-full max-w-shell px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-[15px] font-medium tracking-[-0.01em] text-ink">Angles</h1>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            Message variants and their human-reply rates. Attribution is per-campaign only.
          </p>
        </div>
        <Link href="/" className="text-[12px] text-ink-muted underline-offset-4 hover:underline">
          Back to dashboard
        </Link>
      </header>
      <AngleManager
        initialAngles={angles ?? []}
        initialPerformance={performance?.angles ?? []}
        campaigns={(campaigns?.campaigns ?? []) as { id: string; name: string }[]}
        ownerEmail={getOwnerEmail()}
      />

      {/* Shared workspace provenance on the same live artifact. */}
      <ArtifactProvenance
        ownerEmail={getOwnerEmail()}
        revisionsUrl={`${base}/api/revisions`}
        approvalsUrl={`${base}/api/approvals`}
        commentsUrl={`${base}/api/comments`}
        artifactType="angles"
        artifactId=""
        rowName="Angle"
      />
    </main>
  )
}