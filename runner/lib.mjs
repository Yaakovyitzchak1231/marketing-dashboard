// The runner's testable logic (runner/index.mjs is the thin env + loop
// wrapper, matching the pattern in ops/hermes-relay/{relay.mjs,lib.mjs}).
// No npm dependencies: just global fetch.

/** One call to the dashboard's ops API, authenticated as the runner's own ('system') key. */
export function makeOps({ dashboardUrl, runnerKey, fetchImpl = fetch }) {
  return async function ops(op, args = {}, { timeoutMs = 30_000 } = {}) {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(`${dashboardUrl}/api/ops`, {
        method: 'POST',
        headers: { authorization: `Bearer ${runnerKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ op, ...args }),
        signal: controller.signal,
      })
      let body
      try {
        body = await res.json()
      } catch {
        body = { ok: false, error: `HTTP ${res.status} (non-JSON body)` }
      }
      if (!body.ok) throw new Error(`ops ${op} failed: ${body.error || res.status}`)
      return body.data
    } finally {
      clearTimeout(t)
    }
  }
}

/** Run one claimed job: its handler, under a timeout, then report the outcome via ops(). Never throws. */
export async function runOne(claim, { handlers, ops, log = () => {} }) {
  const { job, run_id } = claim
  const handler = handlers.get(job.kind)
  const startedAt = Date.now()
  if (!handler) {
    await ops('finish_job_run', { run_id, status: 'skipped', error: `unknown job kind "${job.kind}" -- no handler registered` }).catch((e) =>
      log(`${job.name}: could not report skip -- ${e.message}`),
    )
    log(`${job.name} (run ${run_id}): skipped -- unknown kind "${job.kind}"`)
    return { status: 'skipped' }
  }
  const controller = new AbortController()
  const timeoutMs = Math.max(1, Number(job.timeout_s) || 600) * 1000
  const timer = setTimeout(() => controller.abort(new Error('job timeout')), timeoutMs)
  try {
    const output = await handler.handle({
      campaignId: job.campaign_id ?? null,
      payload: job.payload ?? {},
      signal: controller.signal,
      ops,
      log: (m) => log(`${job.name} (run ${run_id}): ${m}`),
    })
    await ops('finish_job_run', { run_id, status: 'ok', output: output ?? {} })
    log(`${job.name} (run ${run_id}): ok, ${Date.now() - startedAt}ms`)
    return { status: 'ok', output }
  } catch (e) {
    const aborted = controller.signal.aborted
    const status = aborted ? 'timeout' : 'failed'
    const message = (e && e.message) || String(e)
    await ops('finish_job_run', { run_id, status, error: message.slice(0, 2000) }).catch((e2) =>
      log(`${job.name} (run ${run_id}): could not report ${status} -- ${e2.message}`),
    )
    log(`${job.name} (run ${run_id}): ${status} -- ${message}`)
    return { status, error: message }
  } finally {
    clearTimeout(timer)
  }
}

/** One poll: claim due jobs, run each (in parallel), return their outcomes. */
export async function pollOnce({ ops, handlers, runnerId, claimLimit = 5, log = () => {} }) {
  const claimed = await ops('claim_jobs', { runner: runnerId, limit: claimLimit })
  if (!claimed || !claimed.length) return []
  log(`claimed ${claimed.length} job${claimed.length === 1 ? '' : 's'}: ${claimed.map((c) => c.job.name).join(', ')}`)
  return Promise.all(claimed.map((c) => runOne(c, { handlers, ops, log })))
}
