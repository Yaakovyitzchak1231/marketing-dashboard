// job kind: integration_changedetection -- changes in the last 24h per watch,
// grouped by tag. Maps a tag to a dashboard campaign by matching
// lp.campaigns.name (list_campaigns); untagged watches roll up under tag "".
// Env: CHANGEDETECTION_API_URL (falls back to the integration's api_url),
// CHANGEDETECTION_API_KEY (from the tool's Settings -> API page).
export const kind = 'integration_changedetection'

const DAY_MS = 24 * 60 * 60 * 1000

export async function handle(ctx) {
  const integrationId = (ctx.payload && ctx.payload.integration_id) || 'changedetection'
  const apiKey = process.env.CHANGEDETECTION_API_KEY
  if (!apiKey) {
    ctx.log('CHANGEDETECTION_API_KEY not set in the runner env -- nothing read')
    return { ok: false, reason: 'not configured' }
  }
  let baseUrl = process.env.CHANGEDETECTION_API_URL
  if (!baseUrl) {
    const integration = await ctx.ops('get_integration', { id: integrationId })
    baseUrl = integration.api_url
  }
  if (!baseUrl) throw new Error('no changedetection.io API URL (set CHANGEDETECTION_API_URL or the integration\'s api_url)')
  baseUrl = baseUrl.replace(/\/+$/, '')

  const headers = { 'x-api-key': apiKey }
  const controller = new AbortController()
  const onAbort = () => controller.abort(new Error('job timeout'))
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  try {
    const campaigns = await ctx.ops('list_campaigns', {})
    const byName = new Map(campaigns.map((c) => [String(c.name).toLowerCase(), c.id]))

    const res = await fetch(`${baseUrl}/api/v1/watch`, { headers, signal: controller.signal })
    if (!res.ok) throw new Error(`changedetection /api/v1/watch -> HTTP ${res.status}`)
    const watches = await res.json() // { "<uuid>": { title, tags, last_changed, ... }, ... }
    const cutoff = Date.now() - DAY_MS
    const byTag = new Map() // tag -> count of changes in the last 24h
    for (const w of Object.values(watches || {})) {
      const lastChanged = Number(w.last_changed) * 1000 // unix seconds -> ms
      const changedRecently = Number.isFinite(lastChanged) && lastChanged >= cutoff
      const tags = w.tags && typeof w.tags === 'object' ? Object.values(w.tags).map((t) => String(t.title ?? t)) : []
      const keys = tags.length ? tags : ['']
      for (const tag of keys) {
        byTag.set(tag, (byTag.get(tag) ?? 0) + (changedRecently ? 1 : 0))
      }
    }
    const snapshots = []
    for (const [tag, count] of byTag) {
      const campaignId = tag ? (byName.get(tag.toLowerCase()) ?? null) : null
      snapshots.push({ metric: 'changedetection.changes_24h', value: count, dims: tag ? { tag } : {}, campaign_id: campaignId })
    }
    if (!snapshots.length) {
      snapshots.push({ metric: 'changedetection.changes_24h', value: 0, dims: {}, campaign_id: null })
    }
    await ctx.ops('put_integration_snapshots', { id: integrationId, snapshots })
    ctx.log(`${Object.keys(watches || {}).length} watch(es), ${snapshots.length} tag group(s)`)
    return { watches: Object.keys(watches || {}).length, groups: snapshots.length }
  } finally {
    ctx.signal.removeEventListener('abort', onAbort)
  }
}
