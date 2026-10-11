// job kind: integration_miniflux -- unread entries per Miniflux category.
// Maps a category title to a dashboard campaign by matching lp.campaigns.name
// (list_campaigns). A category with no matching campaign writes its snapshot
// with campaign_id null (dims.category still names it).
// Env: MINIFLUX_API_URL (falls back to the integration's api_url), MINIFLUX_API_KEY.
export const kind = 'integration_miniflux'

export async function handle(ctx) {
  const integrationId = (ctx.payload && ctx.payload.integration_id) || 'miniflux'
  const apiKey = process.env.MINIFLUX_API_KEY
  if (!apiKey) {
    ctx.log('MINIFLUX_API_KEY not set in the runner env -- nothing read')
    return { ok: false, reason: 'not configured' }
  }
  let baseUrl = process.env.MINIFLUX_API_URL
  if (!baseUrl) {
    const integration = await ctx.ops('get_integration', { id: integrationId })
    baseUrl = integration.api_url
  }
  if (!baseUrl) throw new Error('no Miniflux API URL (set MINIFLUX_API_URL or the integration\'s api_url)')
  baseUrl = baseUrl.replace(/\/+$/, '')

  const headers = { 'X-Auth-Token': apiKey }
  const controller = new AbortController()
  const onAbort = () => controller.abort(new Error('job timeout'))
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  try {
    const campaigns = await ctx.ops('list_campaigns', {})
    const byName = new Map(campaigns.map((c) => [String(c.name).toLowerCase(), c.id]))

    const res = await fetch(`${baseUrl}/v1/categories`, { headers, signal: controller.signal })
    if (!res.ok) throw new Error(`Miniflux /v1/categories -> HTTP ${res.status}`)
    const categories = await res.json()
    const snapshots = []
    for (const category of categories) {
      const title = String(category.title ?? '')
      let unread = null
      try {
        const er = await fetch(`${baseUrl}/v1/categories/${category.id}/entries?status=unread&limit=1`, { headers, signal: controller.signal })
        if (er.ok) {
          const body = await er.json()
          unread = typeof body.total === 'number' ? body.total : null
        } else {
          ctx.log(`category ${category.id} ("${title}") unread count -> HTTP ${er.status}`)
        }
      } catch (e) {
        ctx.log(`category ${category.id} ("${title}") unread count failed: ${e.message}`)
      }
      const campaignId = byName.get(title.toLowerCase()) ?? null
      snapshots.push({ metric: 'miniflux.unread', value: unread, dims: { category: title }, campaign_id: campaignId })
    }
    if (snapshots.length) await ctx.ops('put_integration_snapshots', { id: integrationId, snapshots })
    ctx.log(`${snapshots.length} categor${snapshots.length === 1 ? 'y' : 'ies'} read`)
    return { categories: snapshots.length }
  } finally {
    ctx.signal.removeEventListener('abort', onAbort)
  }
}
