// job kind: instantly_reconcile -- nightly catch-up for per-lead Instantly
// activity the webhook missed (plan 1.6). All the real work (the Instantly API
// calls, the idempotent lp.lead_events insert) happens server-side behind the
// instantly_reconcile_run op (lib/instantly/ops.ts -> lib/instantly/reconcile.ts);
// this handler just calls it with the runner's own key and logs the summary.
// payload: { since_days? } (default 14, see lib/instantly/reconcile.ts)
export const kind = 'instantly_reconcile'

export async function handle(ctx) {
  const result = await ctx.ops('instantly_reconcile_run', { since_days: ctx.payload?.since_days })
  ctx.log(
    `contacts ${result.contacts_checked}, leads ${result.leads_fetched}, threads ${result.threads_fetched}: ` +
      `${result.events_inserted} new event(s), ${result.events_skipped_duplicate} already known` +
      (result.errors?.length ? `; errors: ${result.errors.join(' | ')}` : ''),
  )
  return result
}
