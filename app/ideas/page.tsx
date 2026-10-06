import { IdeaManager } from '@/components/idea-manager'
import { getBaseUrl, getOwnerEmail } from '@/lib/base-url'
import { PERFORMANCE_RANGE } from '@/lib/range'

import Link from 'next/link'

export const dynamic = 'force-dynamic'

async function getJson<T>(url: string, cookie?: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      headers: cookie ? { cookie } : undefined,
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

export default async function IdeasPage() {
  // Origin for the server-side self-fetch. The fallback port lives in
  // lib/base-url.ts so this file never carries a numeric literal.
  const base = getBaseUrl()
  const { cookies } = await import('next/headers')
  const cookie = (await cookies()).toString()

  // PERFORMANCE_RANGE is the window this view reports over. Inlining `30d`
  // would put a number in the render path that no query produced.
  const [ideas, performance] = await Promise.all([
    getJson<unknown[]>(`${base}/api/ideas`, cookie),
    getJson<{ ideas: unknown[] }>(`${base}/api/ideas/performance?range=${PERFORMANCE_RANGE}`, cookie),
  ])

  return (
    <main className="mx-auto w-full max-w-shell px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-[15px] font-medium tracking-[-0.01em] text-ink">
            Ideas
          </h1>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            What we are trying, what it costs, and what it returns.
          </p>
        </div>
        <Link href="/" className="text-[12px] text-ink-muted underline-offset-4 hover:underline">
          Back to dashboard
        </Link>
      </header>

      <IdeaManager
        initialIdeas={(ideas ?? []) as never[]}
        initialPerformance={((performance?.ideas ?? []) as never[])}
        ownerEmail={getOwnerEmail()}
      />
    </main>
  )
}
