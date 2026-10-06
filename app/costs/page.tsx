import { CostManager } from '@/components/cost-manager'
import { getBaseUrl, getOwnerEmail } from '@/lib/base-url'

import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default async function CostsPage() {
  // Origin for the server-side self-fetch. The fallback port lives in
  // lib/base-url.ts so this file never carries a numeric literal.
  const base = getBaseUrl()
  const { cookies } = await import('next/headers')
  const cookie = (await cookies()).toString()

  const fetchJson = async (url: string) => {
    try {
      const res = await fetch(url, { cache: 'no-store', headers: cookie ? { cookie } : undefined })
      if (!res.ok) return []
      return await res.json()
    } catch {
      return []
    }
  }

  const [costs, ideas] = await Promise.all([
    fetchJson(`${base}/api/costs`),
    fetchJson(`${base}/api/ideas`),
  ])

  return (
    <main className="mx-auto w-full max-w-shell px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-[15px] font-medium tracking-[-0.01em] text-ink">Costs</h1>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            Every dollar spent, linked to the idea it served.
          </p>
        </div>
        <Link href="/ideas" className="text-[12px] text-ink-muted underline-offset-4 hover:underline">
          Back to ideas
        </Link>
      </header>
      <CostManager
        initialCosts={costs}
        ideas={ideas}
        ownerEmail={getOwnerEmail()}
      />
    </main>
  )
}
