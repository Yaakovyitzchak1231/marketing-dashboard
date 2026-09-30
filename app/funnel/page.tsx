import Link from 'next/link'

export const dynamic = 'force-dynamic'

async function getBaseUrl() {
  const port = process.env.PORT ?? '3000'
  return (
    process.env.NEXT_PUBLIC_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://127.0.0.1:${port}`)
  )
}

type FunnelRow = {
  campaign_id?: string
  campaign_name?: string
  idea_id?: string
  idea_name: string
  contacted: number | null
  replied: number | null
  positive: number | null
  meetings: number | null
  customers: number | null
  reply_rate: number | null
  positive_rate: number | null
  meeting_rate: number | null
  close_rate: number | null
}

const num = (v: number | null) => (v === null ? '—' : v.toLocaleString())
const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`)

function FunnelTable({ rows, label }: { rows: FunnelRow[]; label: string }) {
  if (rows.length === 0) {
    return <p className="text-[13px] text-ink-faint">No {label} funnel data yet.</p>
  }
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.06em] text-ink-muted">
            <th className="px-4 py-2 font-medium">{label}</th>
            <th className="px-4 py-2 text-right font-medium">Contacted</th>
            <th className="px-4 py-2 text-right font-medium">Replied</th>
            <th className="px-4 py-2 text-right font-medium">Positive</th>
            <th className="px-4 py-2 text-right font-medium">Meetings</th>
            <th className="px-4 py-2 text-right font-medium">Customers</th>
            <th className="px-4 py-2 text-right font-medium">Reply %</th>
            <th className="px-4 py-2 text-right font-medium">Positive %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line last:border-0">
              <td className="px-4 py-2 text-ink">{r.campaign_name ?? r.idea_name}</td>
              <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{num(r.contacted)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{num(r.replied)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{num(r.positive)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{num(r.meetings)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{num(r.customers)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-ink">{pct(r.reply_rate)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-ink">{pct(r.positive_rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default async function FunnelPage() {
  const base = await getBaseUrl()
  const { cookies } = await import('next/headers')
  const cookie = (await cookies()).toString()

  let data: { campaigns: FunnelRow[]; ideas: FunnelRow[] } | null = null
  try {
    const res = await fetch(`${base}/api/funnel?range=30d`, {
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
          <h1 className="text-[15px] font-medium tracking-[-0.01em] text-ink">Funnel</h1>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            Contacted → replied → positive → meeting → customer. Last 30 days.
          </p>
        </div>
        <Link href="/" className="text-[12px] text-ink-muted underline-offset-4 hover:underline">
          Back to dashboard
        </Link>
      </header>

      {data === null ? (
        <p className="text-[13px] text-ink-faint">Funnel data is unavailable right now.</p>
      ) : (
        <div className="space-y-8">
          <section>
            <h2 className="mb-3 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-muted">
              By idea
            </h2>
            <FunnelTable rows={data.ideas} label="Idea" />
          </section>
          <section>
            <h2 className="mb-3 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-muted">
              By campaign
            </h2>
            <FunnelTable rows={data.campaigns} label="Campaign" />
          </section>
        </div>
      )}
    </main>
  )
}
