import { describe, it, expect, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { runOne, HANDLER_OPS_TIMEOUT_MS } from '../runner/lib.mjs'

// Review fix (Hermes, Oct 11): the runner gave every ops call 30 s and /api/ops had no
// maxDuration, so long ops (score_refresh, traits_refresh, reconcile) could never finish.
describe('long job ops get the time they need', () => {
  it("a handler's ops calls get the long timeout; the runner's own calls keep their default", async () => {
    const calls: { op: string; opts: unknown }[] = []
    const ops = vi.fn(async (op: string, _args: unknown, opts?: unknown) => {
      calls.push({ op, opts })
      return {}
    })
    const handlers = new Map([['ops_call', { kind: 'ops_call', handle: async (ctx: { ops: (op: string, a?: object) => Promise<unknown> }) => ctx.ops('recompute_scores', { summary: true }) }]])
    await runOne({ job: { name: 'score_refresh', kind: 'ops_call', payload: {}, timeout_s: 1800 }, run_id: 1 }, { handlers, ops })
    expect(calls.find((c) => c.op === 'recompute_scores')?.opts).toEqual({ timeoutMs: HANDLER_OPS_TIMEOUT_MS })
    expect(HANDLER_OPS_TIMEOUT_MS).toBeGreaterThanOrEqual(300_000)
    expect(calls.find((c) => c.op === 'finish_job_run')?.opts).toBeUndefined()
  })

  it('the ops route and the MCP ops route both allow 300 s', async () => {
    const mod = await import('@/app/api/ops/[[...path]]/route')
    expect(mod.maxDuration).toBe(300)
    const mcp = await import('@/app/api/ops/mcp/route')
    expect(mcp.maxDuration).toBe(300)
  })
})
