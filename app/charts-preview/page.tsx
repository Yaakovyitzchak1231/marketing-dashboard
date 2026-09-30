import { ChartsBlock } from '@/components/charts/ChartsBlock'
import dashboard from '../../collector/data/dashboard.json'
import history from '../../collector/data/history.json'

/**
 * A render harness for the charts, driven by the real collector output.
 *
 * This exists so the charts can be verified against actual collected data rather
 * than fixtures. It is NOT the dashboard page — the shell task owns `app/page.tsx`.
 */
export default function ChartsPreview() {
  const t = dashboard.totals

  // Per-campaign daily rows do not exist in the collector's overview output yet, so
  // the trend is shown from the one day of history that IS stored. Nothing is
  // invented to fill the gap.
  // The collector reports sender health as fleet_total / fleet_healthy; its own
  // `sender_health` field is null on the last run, so it is not used here.
  const rows = history.map((h) => ({
    metric_date: h.day,
    emails_sent: h.emails_sent,
    replies_human: h.replies,
    replies_autoresponder: h.replies_all - h.replies,
  }))

  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: 24, background: '#faf9f7', minHeight: '100vh' }}>
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: '0 0 4px' }}>Charts</h1>
      <p style={{ fontSize: 13, color: '#78716c', margin: '0 0 20px' }}>
        Rendered from collector/data/dashboard.json and history.json
      </p>
      <ChartsBlock
        trendRows={rows}
        openValue={t.opportunity_value}
        openCount={t.opportunities}
        totalValue={null}
        mailboxTotal={t.fleet_total}
        mailboxHealthy={t.fleet_healthy}
      />
    </main>
  )
}
