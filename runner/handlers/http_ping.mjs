// job kind: http_ping -- payload.url, checks it answers; for a competitor
// page, a tool's health endpoint, or anything else worth a periodic "is it up".
// payload: { url: string, expect_status?: number (default: any 2xx-3xx), timeout_ms?: number }
export const kind = 'http_ping'

export async function handle(ctx) {
  const url = ctx.payload && ctx.payload.url
  if (!url || typeof url !== 'string') throw new Error('http_ping payload needs a "url" string')
  const timeoutMs = Math.min(Number(ctx.payload.timeout_ms) || 10_000, 60_000)
  const controller = new AbortController()
  const onAbort = () => controller.abort(new Error('job timeout'))
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  const t = setTimeout(() => controller.abort(new Error('http_ping timeout')), timeoutMs)
  const startedAt = Date.now()
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    const elapsedMs = Date.now() - startedAt
    const expect = ctx.payload.expect_status
    const ok = expect != null ? res.status === Number(expect) : res.status >= 200 && res.status < 400
    ctx.log(`${url} -> ${res.status} in ${elapsedMs}ms`)
    if (!ok) throw new Error(`${url} answered ${res.status} (expected ${expect != null ? expect : '2xx/3xx'})`)
    return { url, status: res.status, elapsed_ms: elapsedMs }
  } finally {
    clearTimeout(t)
    ctx.signal.removeEventListener('abort', onAbort)
  }
}
