import Link from 'next/link'

export const dynamic = 'force-dynamic'

async function getBaseUrl() {
  const port = process.env.PORT ?? '3000'
  return (
    process.env.NEXT_PUBLIC_BASE_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://127.0.0.1:${port}`)
  )
}

type DomainRow = {
  domain: string
  registrar: string | null
  status: string | null
  expires_at: string | null
  auto_renew: boolean | null
  dns_healthy: boolean | null
  expiring_soon: boolean
  unhealthy: boolean
}

type InboxRow = {
  email_address: string
  domain: string | null
  provider: string | null
  health_status: string | null
  warmup_enabled: boolean | null
  warmup_score: number | null
  unhealthy: boolean
}

export default async function InfrastructurePage() {
  const base = await getBaseUrl()
  const { cookies } = await import('next/headers')
  const cookie = (await cookies()).toString()

  let data: {
    domains: DomainRow[]
    inboxes: InboxRow[]
    expiring_soon_count: number
    unhealthy_domain_count: number
    unhealthy_inbox_count: number
    collectors_blocked: string[]
  } | null = null
  try {
    const res = await fetch(`${base}/api/infrastructure`, {
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
          <h1 className="text-[15px] font-medium tracking-[-0.01em] text-ink">
            Infrastructure
          </h1>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            Domains and inboxes: what is unhealthy, what expires soon.
          </p>
        </div>
        <Link href="/" className="text-[12px] text-ink-muted underline-offset-4 hover:underline">
          Back to dashboard
        </Link>
      </header>

      {data === null ? (
        <p className="text-[13px] text-ink-faint">Infrastructure data is unavailable right now.</p>
      ) : (
        <div className="space-y-8">
          {data.collectors_blocked.length > 0 && (
            <div className="border-l-2 border-warn px-3 py-2 text-[12px] text-ink-muted">
              Waiting on credentials: {data.collectors_blocked.join(', ')}. No data has been
              collected yet — nothing here is a measurement.
            </div>
          )}

          <section>
            <h2 className="mb-3 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-muted">
              Domains
              {data.expiring_soon_count > 0 && (
                <span className="ml-2 normal-case tracking-normal text-ink">
                  {data.expiring_soon_count} expiring within 14 days
                </span>
              )}
            </h2>
            {data.domains.length === 0 ? (
              <p className="text-[13px] text-ink-faint">No domains recorded.</p>
            ) : (
              <div className="overflow-x-auto rounded-card border border-line bg-surface">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.06em] text-ink-muted">
                      <th className="px-4 py-2 font-medium">Domain</th>
                      <th className="px-4 py-2 font-medium">Expires</th>
                      <th className="px-4 py-2 font-medium">Auto-renew</th>
                      <th className="px-4 py-2 font-medium">DNS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.domains.map(d => (
                      <tr key={d.domain} className="border-b border-line last:border-0">
                        <td className="px-4 py-2 text-ink">
                          {d.domain}
                          {d.expiring_soon && (
                            <span className="ml-2 text-[11px] text-warn">expiring soon</span>
                          )}
                          {d.unhealthy && (
                            <span className="ml-2 text-[11px] text-warn">dns failing</span>
                          )}
                        </td>
                        <td className="px-4 py-2 tabular-nums text-ink-muted">
                          {d.expires_at ? d.expires_at.split('T')[0] : '—'}
                        </td>
                        <td className="px-4 py-2 text-ink-muted">
                          {d.auto_renew === null ? '—' : d.auto_renew ? 'on' : 'off'}
                        </td>
                        <td className="px-4 py-2 text-ink-muted">
                          {d.dns_healthy === null ? '—' : d.dns_healthy ? 'ok' : 'failing'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-3 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-muted">
              Inboxes
              {data.unhealthy_inbox_count > 0 && (
                <span className="ml-2 normal-case tracking-normal text-ink">
                  {data.unhealthy_inbox_count} unhealthy
                </span>
              )}
            </h2>
            {data.inboxes.length === 0 ? (
              <p className="text-[13px] text-ink-faint">No inboxes recorded.</p>
            ) : (
              <div className="overflow-x-auto rounded-card border border-line bg-surface">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.06em] text-ink-muted">
                      <th className="px-4 py-2 font-medium">Inbox</th>
                      <th className="px-4 py-2 font-medium">Health</th>
                      <th className="px-4 py-2 font-medium">Warmup</th>
                      <th className="px-4 py-2 text-right font-medium">Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.inboxes.map(i => (
                      <tr key={i.email_address} className="border-b border-line last:border-0">
                        <td className="px-4 py-2 text-ink">
                          {i.email_address}
                          {i.unhealthy && (
                            <span className="ml-2 text-[11px] text-warn">unhealthy</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-ink-muted">{i.health_status ?? '—'}</td>
                        <td className="px-4 py-2 text-ink-muted">
                          {i.warmup_enabled === null ? '—' : i.warmup_enabled ? 'on' : 'off'}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-ink-muted">
                          {i.warmup_score ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  )
}
