import { describe, it, expect, vi } from 'vitest'
import { makeOps, runOne, pollOnce } from '../runner/lib.mjs'

type FakeFetchCall = { url: string; headers: Record<string, string> }

/** A plain function matching the global fetch signature (not a vi.fn -- its overloaded type fights
 * vi.fn's generics), recording each call's url/headers on the given array for assertions. */
function fakeFetch(handler: (op: string, args: Record<string, unknown>) => unknown, calls: FakeFetchCall[] = []) {
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), headers: (init?.headers as Record<string, string>) ?? {} })
    const body = JSON.parse(String(init?.body))
    const { op, ...args } = body
    try {
      const data = await handler(op, args)
      return { json: async () => ({ ok: true, op, data }) } as Response
    } catch (e) {
      return { json: async () => ({ ok: false, error: (e as Error).message }) } as Response
    }
  }
  return impl
}

const job = (over: Partial<Record<string, unknown>> = {}) => ({
  name: 'test-job', kind: 'heartbeat', campaign_id: null, payload: {}, timeout_s: 1, ...over,
})

describe('runner/lib.mjs: makeOps', () => {
  it('posts {op, ...args} with the runner key and returns data on ok:true', async () => {
    const calls: FakeFetchCall[] = []
    const fetchImpl = fakeFetch((op, args) => {
      expect(op).toBe('whoami')
      expect(args).toEqual({})
      return { id: 'system' }
    }, calls)
    const ops = makeOps({ dashboardUrl: 'https://dash.test', runnerKey: 'secret-key', fetchImpl })
    const data = await ops('whoami', {})
    expect(data).toEqual({ id: 'system' })
    expect(calls[0].url).toBe('https://dash.test/api/ops')
    expect(calls[0].headers.authorization).toBe('Bearer secret-key')
  })

  it('throws with the dashboard\'s error message on ok:false', async () => {
    const fetchImpl = fakeFetch(() => {
      throw new Error('bad input')
    })
    const ops = makeOps({ dashboardUrl: 'https://dash.test', runnerKey: 'k', fetchImpl })
    await expect(ops('put_job', {})).rejects.toThrow(/bad input/)
  })
})

describe('runner/lib.mjs: runOne', () => {
  it('claims -> runs the matching handler -> finishes ok, with its output', async () => {
    const finishCalls: Record<string, unknown>[] = []
    const ops = vi.fn(async (op: string, args: Record<string, unknown>) => {
      if (op === 'finish_job_run') finishCalls.push(args)
      return {}
    })
    const handlers = new Map([['heartbeat', { handle: async () => ({ at: 'now' }) }]])
    const result = await runOne({ job: job(), run_id: 42 }, { handlers, ops })
    expect(result.status).toBe('ok')
    expect(finishCalls).toEqual([{ run_id: 42, status: 'ok', output: { at: 'now' } }])
  })

  it('a handler that throws finishes as failed with the error message', async () => {
    const finishCalls: Record<string, unknown>[] = []
    const ops = vi.fn(async (op: string, args: Record<string, unknown>) => {
      if (op === 'finish_job_run') finishCalls.push(args)
      return {}
    })
    const handlers = new Map([['heartbeat', { handle: async () => { throw new Error('db exploded') } }]])
    const result = await runOne({ job: job(), run_id: 7 }, { handlers, ops })
    expect(result.status).toBe('failed')
    expect(finishCalls[0]).toMatchObject({ run_id: 7, status: 'failed', error: 'db exploded' })
  })

  it('a handler that outlives timeout_s finishes as timeout, via the given AbortSignal', async () => {
    const finishCalls: Record<string, unknown>[] = []
    const ops = vi.fn(async (op: string, args: Record<string, unknown>) => {
      if (op === 'finish_job_run') finishCalls.push(args)
      return {}
    })
    const handlers = new Map([
      [
        'slow',
        {
          handle: ({ signal }: { signal: AbortSignal }) =>
            new Promise((resolve, reject) => {
              signal.addEventListener('abort', () => reject(new Error('aborted')))
            }),
        },
      ],
    ])
    const result = await runOne({ job: job({ kind: 'slow', timeout_s: 0.05 }), run_id: 9 }, { handlers, ops })
    expect(result.status).toBe('timeout')
    expect(finishCalls[0]).toMatchObject({ run_id: 9, status: 'timeout' })
  })

  it('an unknown job kind finishes as skipped with a clear error, without calling any handler', async () => {
    const finishCalls: Record<string, unknown>[] = []
    const ops = vi.fn(async (op: string, args: Record<string, unknown>) => {
      if (op === 'finish_job_run') finishCalls.push(args)
      return {}
    })
    const handlers = new Map()
    const result = await runOne({ job: job({ kind: 'does_not_exist' }), run_id: 3 }, { handlers, ops })
    expect(result.status).toBe('skipped')
    expect(finishCalls[0]).toMatchObject({ run_id: 3, status: 'skipped' })
    expect(String(finishCalls[0].error)).toContain('does_not_exist')
  })

  it('never logs the key or anything the dashboard sent back that looks secret-shaped', async () => {
    const lines: string[] = []
    const ops = vi.fn(async (op: string) => (op === 'finish_job_run' ? {} : {}))
    const handlers = new Map([['heartbeat', { handle: async () => ({ ok: true }) }]])
    await runOne({ job: job(), run_id: 1 }, { handlers, ops, log: (...a: unknown[]) => { lines.push(String(a[0])) } })
    for (const l of lines) {
      expect(l).not.toMatch(/secret-key|RUNNER_KEY/i)
    }
  })
})

describe('runner/lib.mjs: pollOnce', () => {
  it('claims several jobs and runs them all, reporting each outcome', async () => {
    const claimed = [
      { job: job({ name: 'a' }), run_id: 1 },
      { job: job({ name: 'b', kind: 'unknown_kind' }), run_id: 2 },
    ]
    const finishCalls: Record<string, unknown>[] = []
    const ops = vi.fn(async (op: string, args: Record<string, unknown>) => {
      if (op === 'claim_jobs') return claimed
      if (op === 'finish_job_run') {
        finishCalls.push(args)
        return {}
      }
      return {}
    })
    const handlers = new Map([['heartbeat', { handle: async () => ({ done: true }) }]])
    const results = await pollOnce({ ops, handlers, runnerId: 'runner-1', claimLimit: 5 })
    expect(results.map((r) => r.status)).toEqual(['ok', 'skipped'])
    expect(finishCalls).toHaveLength(2)
    expect(ops).toHaveBeenCalledWith('claim_jobs', { runner: 'runner-1', limit: 5 })
  })

  it('an empty claim does nothing and returns no results', async () => {
    const ops = vi.fn(async (op: string) => (op === 'claim_jobs' ? [] : {}))
    const results = await pollOnce({ ops, handlers: new Map(), runnerId: 'r', claimLimit: 5 })
    expect(results).toEqual([])
  })
})
