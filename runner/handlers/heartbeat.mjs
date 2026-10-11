// job kind: heartbeat -- records that the runner is alive, with a timestamp.
// Useful as the simplest possible lp.jobs row to test a schedule end-to-end.
export const kind = 'heartbeat'

export async function handle(ctx) {
  const now = new Date().toISOString()
  ctx.log(`heartbeat at ${now}`)
  return { ok: true, at: now, campaign_id: ctx.campaignId }
}
