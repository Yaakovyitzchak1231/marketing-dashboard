import { ChartsBlock } from '@/components/charts/ChartsBlock'
import dashboard from '../../collector/fixtures/dashboard.json'
import history from '../../collector/fixtures/history.json'
import { PAGE_GEOMETRY } from '@/lib/chart'

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

  const { 
    maxWidth, 
    margin, 
    padding, 
    minHeight, 
    background, 
    titleFontSize, 
    titleFontWeight, 
    titleMargin,
    subtitleFontSize, 
    subtitleColor, 
    subtitleMargin 
  } = PAGE_GEOMETRY

  return (
    <main style={{ maxWidth, margin: '0 auto', padding, background, minHeight }}>
      <h1 style={{ fontSize: titleFontSize, fontWeight: titleFontWeight, margin: titleMargin }}>Charts</h1>
      <p style={{ fontSize: subtitleFontSize, color: subtitleColor, margin: subtitleMargin }}>
        Rendered from collector/fixtures/dashboard.json and history.json
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
