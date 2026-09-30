import { IdeaManager } from '@/components/idea-manager'

import Link from 'next/link'

export const dynamic = 'force-dynamic'

async function getBaseUrl() {
  const port = process.env.PORT ?? '3000'
  return (
    process.env.NEXT_PUBLIC_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://127.0.0.1:${port}`)
  )
}

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
  const base = await getBaseUrl()
  const { cookies } = await import('next/headers')
  const cookie = (await cookies()).toString()

  const [ideas, performance] = await Promise.all([
    getJson<unknown[]>(`${base}/api/ideas`, cookie),
    getJson<{ ideas: unknown[] }>(`${base}/api/ideas/performance?range=30d`, cookie),
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
      />
    </main>
  )
}
