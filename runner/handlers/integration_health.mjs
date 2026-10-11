// job kind: integration_health -- checks each tool's health/root endpoint and
// reports the result through report_integration_health. One generic handler
// covers every tool in lp.integrations (Warmbly, Listmonk, Miniflux,
// changedetection.io, Umami, ...); docs/sheets (kind "sheet"/"doc") have no
// API to check and are skipped.
// payload: { ids?: string[], timeout_ms? (default 8000) }
export const kind = 'integration_health'

const SKIP_KINDS = new Set(['sheet', 'doc', 'link'])

async function checkOne(integration, timeoutMs) {
  const target = integration.api_url || integration.url
  if (!target) return { status: 'unknown', detail: 'no URL on file' }
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  const startedAt = Date.now()
  try {
    const res = await fetch(target, { signal: controller.signal, redirect: 'follow' })
    const elapsedMs = Date.now() - startedAt
    if (res.status >= 200 && res.status < 400) return { status: 'ok', detail: `HTTP ${res.status} in ${elapsedMs}ms` }
    return { status: 'degraded', detail: `HTTP ${res.status} in ${elapsedMs}ms` }
  } catch (e) {
    const msg = (e && e.message) || String(e)
    return { status: 'down', detail: msg.slice(0, 500) }
  } finally {
    clearTimeout(t)
  }
}

export async function handle(ctx) {
  const timeoutMs = Math.min(Number(ctx.payload.timeout_ms) || 8000, 30_000)
  const wantIds = Array.isArray(ctx.payload.ids) ? new Set(ctx.payload.ids) : null
  const all = await ctx.ops('list_integrations', { active_only: true })
  const targets = all.filter((i) => !SKIP_KINDS.has(i.kind) && (!wantIds || wantIds.has(i.id)))
  const results = []
  for (const integration of targets) {
    if (ctx.signal.aborted) break
    const r = await checkOne(integration, timeoutMs)
    await ctx.ops('report_integration_health', { id: integration.id, status: r.status, detail: r.detail })
    ctx.log(`${integration.id}: ${r.status} (${r.detail})`)
    results.push({ id: integration.id, ...r })
  }
  return { checked: results.length, results }
}
