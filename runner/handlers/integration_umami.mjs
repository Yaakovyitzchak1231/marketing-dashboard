// job kind: integration_umami -- visits and UTM campaign breakdown for the
// last 24h (and 7d, as a second metric) via Umami's API. Maps each UTM
// campaign value to a dashboard campaign via lp.campaign_profiles.utm.campaign
// (campaign_for_utm_campaign).
// Env: UMAMI_API_URL (falls back to the integration's api_url),
// UMAMI_API_KEY (an Umami API key, header x-umami-api-key),
// UMAMI_WEBSITE_ID (the website to read stats for -- Umami needs at least one
// website set up and the tracker reachable before this returns real numbers).
export const kind = 'integration_umami'

const HOUR_MS = 60 * 60 * 1000

export async function handle(ctx) {
  const integrationId = (ctx.payload && ctx.payload.integration_id) || 'umami'
  const apiKey = process.env.UMAMI_API_KEY
  const websiteId = process.env.UMAMI_WEBSITE_ID
  if (!apiKey || !websiteId) {
    ctx.log('UMAMI_API_KEY / UMAMI_WEBSITE_ID not set in the runner env -- nothing read')
    return { ok: false, reason: 'not configured' }
  }
  let baseUrl = process.env.UMAMI_API_URL
  if (!baseUrl) {
    const integration = await ctx.ops('get_integration', { id: integrationId })
    baseUrl = integration.api_url
  }
  if (!baseUrl) throw new Error('no Umami API URL (set UMAMI_API_URL or the integration\'s api_url)')
  baseUrl = baseUrl.replace(/\/+$/, '')

  const headers = { 'x-umami-api-key': apiKey }
  const controller = new AbortController()
  const onAbort = () => controller.abort(new Error('job timeout'))
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  try {
    const now = Date.now()
    const since24h = now - 24 * HOUR_MS
    const snapshots = []

    const statsRes = await fetch(`${baseUrl}/api/websites/${websiteId}/stats?startAt=${since24h}&endAt=${now}`, { headers, signal: controller.signal })
    let visits24h = null
    if (statsRes.ok) {
      const body = await statsRes.json()
      visits24h = typeof body?.visits?.value === 'number' ? body.visits.value : null
    } else {
      ctx.log(`stats -> HTTP ${statsRes.status}`)
    }
    snapshots.push({ metric: 'umami.visits_24h', value: visits24h, dims: {}, campaign_id: null })

    const utmRes = await fetch(`${baseUrl}/api/websites/${websiteId}/metrics?type=campaign&startAt=${since24h}&endAt=${now}`, { headers, signal: controller.signal })
    if (utmRes.ok) {
      const rows = await utmRes.json() // [{ x: "<utm_campaign>", y: <visits> }, ...]
      for (const r of rows || []) {
        const campaignValue = String(r.x ?? '')
        if (!campaignValue) continue
        let campaignId = null
        try {
          const mapped = await ctx.ops('campaign_for_utm_campaign', { utm_campaign: campaignValue })
          campaignId = mapped && mapped.campaign_id != null ? mapped.campaign_id : null
        } catch (e) {
          ctx.log(`could not map utm_campaign "${campaignValue}": ${e.message}`)
        }
        snapshots.push({
          metric: 'umami.visits_24h',
          value: typeof r.y === 'number' ? r.y : null,
          dims: { utm_campaign: campaignValue },
          campaign_id: campaignId,
        })
      }
    } else {
      ctx.log(`utm campaign breakdown -> HTTP ${utmRes.status}`)
    }

    await ctx.ops('put_integration_snapshots', { id: integrationId, snapshots })
    ctx.log(`${snapshots.length} metric row(s) read`)
    return { rows: snapshots.length }
  } finally {
    ctx.signal.removeEventListener('abort', onAbort)
  }
}
