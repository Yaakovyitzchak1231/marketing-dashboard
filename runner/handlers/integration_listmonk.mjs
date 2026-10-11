// job kind: integration_listmonk -- Listmonk lists + subscriber counts.
// Maps each list to a campaign via lp.campaign_profiles.newsletter_list
// (campaign_for_newsletter_list). A list with no matching profile writes its
// snapshot with campaign_id null (dims.list still names it).
// Env (see docs/RUNNER-integrations.md): LISTMONK_API_URL (falls back to the
// integration's api_url), LISTMONK_API_USER (default "api"), LISTMONK_API_KEY.
export const kind = 'integration_listmonk'

export async function handle(ctx) {
  const integrationId = (ctx.payload && ctx.payload.integration_id) || 'listmonk'
  const apiUser = process.env.LISTMONK_API_USER || 'api'
  const apiKey = process.env.LISTMONK_API_KEY
  if (!apiKey) {
    ctx.log('LISTMONK_API_KEY not set in the runner env -- nothing read')
    return { ok: false, reason: 'not configured' }
  }
  let baseUrl = process.env.LISTMONK_API_URL
  if (!baseUrl) {
    const integration = await ctx.ops('get_integration', { id: integrationId })
    baseUrl = integration.api_url
  }
  if (!baseUrl) throw new Error('no Listmonk API URL (set LISTMONK_API_URL or the integration\'s api_url)')

  const auth = 'Basic ' + Buffer.from(`${apiUser}:${apiKey}`).toString('base64')
  const controller = new AbortController()
  const onAbort = () => controller.abort(new Error('job timeout'))
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/lists`, { headers: { authorization: auth }, signal: controller.signal })
    if (!res.ok) throw new Error(`Listmonk /api/lists -> HTTP ${res.status}`)
    const body = await res.json()
    const lists = (body && body.data && body.data.results) || []
    const snapshots = []
    for (const list of lists) {
      const name = String(list.name ?? '')
      const subscriberCount = typeof list.subscriber_count === 'number' ? list.subscriber_count : null
      let campaignId = null
      try {
        const mapped = await ctx.ops('campaign_for_newsletter_list', { list: name })
        campaignId = mapped && mapped.campaign_id != null ? mapped.campaign_id : null
      } catch (e) {
        ctx.log(`could not map list "${name}" to a campaign: ${e.message}`)
      }
      snapshots.push({ metric: 'listmonk.subscribers', value: subscriberCount, dims: { list: name }, campaign_id: campaignId })
    }
    if (snapshots.length) await ctx.ops('put_integration_snapshots', { id: integrationId, snapshots })
    ctx.log(`${snapshots.length} list(s) read`)
    return { lists: snapshots.length }
  } finally {
    ctx.signal.removeEventListener('abort', onAbort)
  }
}
