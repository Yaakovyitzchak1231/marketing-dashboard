import { afterAll, beforeAll, expect, vi } from 'vitest'

/**
 * Guard for the verification suites: any real request to a paid verifier
 * fails the test (and is counted, so a swallowed error still fails the file).
 * Every test injects its own fake fetch; nothing should ever reach these hosts.
 */
export const PAID_HOSTS = ['api.millionverifier.com', 'bulkapi.millionverifier.com', 'api.zerobounce.net', 'api-us.zerobounce.net', 'api-eu.zerobounce.net']

export const paidCallAttempts: string[] = []

export function installPaidNetworkGuard() {
  const original = globalThis.fetch
  beforeAll(() => {
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input instanceof URL ? input.href : typeof input === 'string' ? input : (input as { url?: string })?.url)
      const host = (() => {
        try {
          return new URL(url).hostname
        } catch {
          return ''
        }
      })()
      if (PAID_HOSTS.includes(host)) {
        paidCallAttempts.push(host)
        throw new Error(`BLOCKED: a test tried to call the paid API at ${host}`)
      }
      throw new Error(`BLOCKED: unexpected network call in a verification test (${host || 'unknown host'})`)
    })
  })
  afterAll(() => {
    vi.unstubAllGlobals()
    if (original) globalThis.fetch = original
    expect(paidCallAttempts, 'a test tried to reach a paid verifier for real').toEqual([])
  })
}

/** A fake fetch that answers from a function and records every URL it saw. */
export function fakeFetch(answer: (url: URL) => { status?: number; body: unknown }) {
  const calls: string[] = []
  const fn = async (input: string) => {
    calls.push(input)
    const a = answer(new URL(input))
    return {
      ok: (a.status ?? 200) < 400,
      status: a.status ?? 200,
      json: async () => a.body,
    }
  }
  return Object.assign(fn, { calls })
}
