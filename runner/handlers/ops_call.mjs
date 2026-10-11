// job kind: ops_call -- the generic way a scheduled job runs one ops API op.
// This is how later per-campaign jobs (instantly_reconcile, a news monitor
// that calls campaign-profile list_profile_items + stores results, a
// tools-hub snapshot poller) run without their own handler file: point a
// lp.jobs row at this kind with the op and args baked into its payload.
// payload: { op: string, args?: object }
export const kind = 'ops_call'

export async function handle(ctx) {
  const op = ctx.payload && ctx.payload.op
  if (!op || typeof op !== 'string') throw new Error('ops_call payload needs an "op" string')
  const args = (ctx.payload.args && typeof ctx.payload.args === 'object') ? ctx.payload.args : {}
  ctx.log(`calling ${op}`)
  const data = await ctx.ops(op, args)
  return { op, result: data }
}
