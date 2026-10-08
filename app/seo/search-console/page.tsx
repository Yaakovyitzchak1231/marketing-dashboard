import { Card, EmptyNote, SectionHeader } from '@/components/dashboard/primitives'
import { formatPct } from '@/components/dashboard/format'
import { Env, SetupCard, Steps } from '@/components/seo/bits'
import { bingConfigFromEnv, bingQueries, gscConfigFromEnv, gscReport, type GscReport, type GscRow } from '@/lib/seo/searchconsole'

export const dynamic = 'force-dynamic'

function Rows({ rows, label }: { rows: GscRow[]; label: string }) {
  if (!rows.length) return <EmptyNote>No rows returned for this period.</EmptyNote>
  return (
    <Card className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-[12px]">
        <thead className="text-left text-ink-faint">
          <tr>
            <th className="px-4 py-2 font-medium">{label}</th>
            <th className="px-2 py-2 text-right font-medium">Clicks</th>
            <th className="px-2 py-2 text-right font-medium">Impressions</th>
            <th className="px-2 py-2 text-right font-medium">CTR</th>
            <th className="px-4 py-2 text-right font-medium">Avg position</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line font-numeric">
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="max-w-[360px] truncate px-4 py-1.5 font-sans text-ink">{r.key}</td>
              <td className="px-2 py-1.5 text-right">{r.clicks.toLocaleString('en-US')}</td>
              <td className="px-2 py-1.5 text-right">{r.impressions.toLocaleString('en-US')}</td>
              <td className="px-2 py-1.5 text-right">{r.impressions ? formatPct(r.ctr) : '—'}</td>
              <td className="px-4 py-1.5 text-right">{r.impressions ? r.position.toFixed(1) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

export default async function SeoSearchConsole() {
  const gsc = gscConfigFromEnv()
  const bing = bingConfigFromEnv()
  let report: GscReport | null = null
  let gscErr: string | null = null
  if (gsc) {
    try {
      report = await gscReport(gsc)
    } catch (e) {
      gscErr = (e as Error).message
    }
  }
  let bingRows: GscRow[] | null = null
  let bingErr: string | null = null
  if (bing) {
    try {
      bingRows = await bingQueries(bing)
    } catch (e) {
      bingErr = (e as Error).message
    }
  }
  return (
    <div className="space-y-7">
      <section>
        <SectionHeader title="Google Search Console" meta={report ? `${report.startDate} to ${report.endDate}, Google's numbers` : undefined} />
        {!gsc ? (
          <SetupCard title="Connect Google Search Console (free)" testId="gsc-setup">
            <Steps
              steps={[
                'console.cloud.google.com > create a project (free) > APIs & Services > Library > enable "Google Search Console API".',
                'IAM & Admin > Service accounts > Create. Open it > Keys > Add key > JSON. Keep the file private.',
                'search.google.com/search-console > tapdash.co > Settings > Users and permissions > Add user: the service account email, permission "Restricted".',
                'In Vercel add GSC_CLIENT_EMAIL (client_email from the file), GSC_PRIVATE_KEY (private_key from the file) and GSC_SITE_URL (sc-domain:tapdash.co, or https://tapdash.co/ for a URL-prefix property). Redeploy.',
              ]}
            />
            <p>
              Read-only. Shows the searches you appear for, clicks, impressions and position, per query and per page. Env: <Env name="GSC_CLIENT_EMAIL" /> <Env name="GSC_PRIVATE_KEY" />{' '}
              <Env name="GSC_SITE_URL" />
            </p>
          </SetupCard>
        ) : gscErr ? (
          <p role="alert" className="rounded-card border border-bad/30 bg-bad-soft px-3 py-2 text-[13px] text-bad">Search Console didn&rsquo;t answer: {gscErr}</p>
        ) : report ? (
          <div className="space-y-4">
            <Rows rows={report.queries} label="Search" />
            <Rows rows={report.pages} label="Page" />
          </div>
        ) : null}
      </section>
      <section>
        <SectionHeader title="Bing Webmaster Tools" meta="ChatGPT's search leans on Bing's index" />
        {!bing ? (
          <SetupCard title="Connect Bing Webmaster Tools (free)" testId="bing-setup">
            <Steps
              steps={[
                'bing.com/webmasters > sign in > Import your site from Google Search Console (one click).',
                'Settings (gear) > API access > API Key > Generate.',
                'In Vercel add BING_WEBMASTER_API_KEY and BING_SITE_URL (https://tapdash.co/). Redeploy.',
                'Optional, free: install Microsoft\u2019s "IndexNow" WordPress plugin so Bing hears about page changes the same day.',
              ]}
            />
          </SetupCard>
        ) : bingErr ? (
          <p role="alert" className="rounded-card border border-bad/30 bg-bad-soft px-3 py-2 text-[13px] text-bad">Bing didn&rsquo;t answer: {bingErr}</p>
        ) : bingRows ? (
          <Rows rows={bingRows} label="Search" />
        ) : null}
      </section>
    </div>
  )
}
