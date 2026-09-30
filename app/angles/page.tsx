import { AngleManager } from '@/components/angle-manager'

import Link from 'next/link'

export const dynamic = 'force-dynamic'

async function getBaseUrl() {
  const port = process.env.PORT ?? '3000'
  return (
    process.env.NEXT_PUBLIC_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://127.0.0.1:${port}`)
  )
}

export default async function AnglesPage() {
  const base = await getBaseUrl()
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

  const [angles, performance, campaigns] = await Promise.all([
    fetchJson(`${base}/api/angles`),
    fetchJson(`${base}/api/angles/performance?range=30d`),
    fetchJson(`${base}/api/campaigns?range=30d`),
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
      />
    </main>
  )
}
