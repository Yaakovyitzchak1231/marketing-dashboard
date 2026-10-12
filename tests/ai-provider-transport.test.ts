// #98 review: the production transport is node:https with a guarded `lookup`, so the socket
// connects to exactly the IP that was validated (closes the DNS-rebinding window between
// "resolve + check" and fetch()'s own second resolution). node:https is mocked: no network.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

type Opts = {
  hostname: string
  port: number | string
  path: string
  method: string
  headers: Record<string, string>
  agent: unknown
  lookup: (host: string, o: object, cb: (e: Error | null, a?: unknown, f?: number) => void) => void
}
const h = vi.hoisted(() => ({
  seen: null as unknown,
  written: [] as string[],
  reply: { status: 200, headers: { 'content-type': 'application/json' } as Record<string, string>, body: '{"ok":true}' },
  // 'respond' (default) | 'hang' | 'connect' (run opts.lookup first, like net.connect, then respond or fail)
  mode: 'respond' as 'respond' | 'hang' | 'connect',
  lookupResult: null as null | { err: Error | null; address?: unknown; family?: number },
  destroyed: 0,
}))

vi.mock('node:https', () => ({
  request: (opts: Opts, onRes: (res: PassThrough & { statusCode: number; headers: Record<string, string> }) => void) => {
    h.seen = opts
    const req = new EventEmitter() as EventEmitter & { write: (s: string) => void; end: () => void; destroy: () => void }
    req.write = (s) => void h.written.push(s)
    req.destroy = () => void (h.destroyed += 1)
    req.end = () => {
      if (h.mode === 'hang') return
      const respond = () => {
        const res = Object.assign(new PassThrough(), { statusCode: h.reply.status, headers: h.reply.headers })
        onRes(res)
        res.end(h.reply.body)
      }
      if (h.mode === 'connect') {
        opts.lookup(opts.hostname, {}, (err, address, family) => {
          h.lookupResult = { err, address, family }
          if (err) req.emit('error', err)
          else respond()
        })
        return
      }
      respond()
    }
    return req
  },
}))

import { pinnedHttpsFetch, providerFetch, providerRequest, AiProviderError } from '@/lib/settings/ai-provider'

const pub = async () => [{ address: '93.184.216.34', family: 4 }]

beforeEach(() => {
  h.seen = null
  h.written = []
  h.reply = { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }
  h.mode = 'respond'
  h.lookupResult = null
  h.destroyed = 0
})

describe('pinnedHttpsFetch', () => {
  it('sends through node:https with the guarded lookup, no agent pooling, body and headers intact', async () => {
    const res = await pinnedHttpsFetch('https://api.example.com/v1/chat/completions?x=1', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer k' }, body: '{"a":1}',
    }, { lookup: pub })
    const o = h.seen as Opts
    expect(o).toMatchObject({ hostname: 'api.example.com', port: 443, path: '/v1/chat/completions?x=1', method: 'POST', agent: false })
    expect(o.headers).toMatchObject({ 'content-type': 'application/json', authorization: 'Bearer k', 'content-length': '7' })
    expect(typeof o.lookup).toBe('function')
    expect(h.written).toEqual(['{"a":1}'])
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('the lookup it installs returns the validated address (what the socket connects to)', async () => {
    h.mode = 'connect'
    await pinnedHttpsFetch('https://api.example.com/v1/models', {}, { lookup: pub })
    expect(h.lookupResult).toEqual({ err: null, address: '93.184.216.34', family: 4 })
  })

  it('a host that resolves privately fails at connect and nothing is sent', async () => {
    h.mode = 'connect'
    await expect(pinnedHttpsFetch('https://rebind.example.com/v1', {}, { lookup: async () => [{ address: '169.254.169.254' }] }))
      .rejects.toMatchObject({ code: 'EBLOCKEDADDR', message: 'The AI provider host resolves to a non-public address.' })
    expect(h.lookupResult?.err).toBeTruthy()
  })

  it('DNS rebinding: one resolution per connection, so a later private answer is never used', async () => {
    h.mode = 'connect'
    const answers = [[{ address: '93.184.216.34' }], [{ address: '10.0.0.1' }]]
    const resolve = vi.fn(async () => answers.shift() ?? [])
    await pinnedHttpsFetch('https://rebind.example.com/v1', {}, { lookup: resolve })
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(h.lookupResult).toMatchObject({ err: null, address: '93.184.216.34' })
  })

  it('returns a 3xx as-is (never follows it) and does not issue a second request', async () => {
    h.reply = { status: 302, headers: { location: 'https://169.254.169.254/' }, body: '' }
    const res = await pinnedHttpsFetch('https://api.example.com/v1', {}, { lookup: pub })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://169.254.169.254/')
  })

  it('handles a null-body status (304) without throwing', async () => {
    h.reply = { status: 304, headers: {}, body: '' }
    expect((await pinnedHttpsFetch('https://api.example.com/v1', {}, { lookup: pub })).status).toBe(304)
  })

  it.each([600, 999, 199, 0])('an out-of-range status (%s) rejects with a person-safe error instead of throwing in the stream', async (status) => {
    h.reply = { status, headers: {}, body: 'x' }
    await expect(pinnedHttpsFetch('https://api.example.com/v1', {}, { lookup: pub })).rejects.toThrow(
      new AiProviderError(`The AI provider answered with an invalid status (${status}).`),
    )
  })

  it('times out and destroys the request', async () => {
    h.mode = 'hang'
    await expect(pinnedHttpsFetch('https://api.example.com/v1', {}, { lookup: pub, timeoutMs: 20 })).rejects.toMatchObject({ name: 'AbortError' })
    expect(h.destroyed).toBeGreaterThan(0)
  })

  it('honors the caller abort signal', async () => {
    h.mode = 'hang'
    const ctrl = new AbortController()
    const p = pinnedHttpsFetch('https://api.example.com/v1', { signal: ctrl.signal }, { lookup: pub })
    ctrl.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    await expect(pinnedHttpsFetch('https://api.example.com/v1', { signal: ctrl.signal }, { lookup: pub })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('refuses a reply over the size cap', async () => {
    h.reply = { status: 200, headers: {}, body: 'x'.repeat(5 * 1024 * 1024 + 1) }
    await expect(pinnedHttpsFetch('https://api.example.com/v1', {}, { lookup: pub })).rejects.toBeInstanceOf(AiProviderError)
  })
})

describe('providerFetch / providerRequest use the pinned transport by default', () => {
  it('a private DNS answer is a person-safe AiProviderError, with no request sent', async () => {
    h.mode = 'connect'
    await expect(providerFetch('https://api.example.com/v1', {}, { lookup: async () => [{ address: '10.0.0.7' }] }))
      .rejects.toThrow('The AI provider host resolves to a non-public address.')
  })
  it('refuses a redirect and sends redirect:manual semantics (3xx surfaced as an error)', async () => {
    h.reply = { status: 307, headers: { location: 'https://10.0.0.1/' }, body: '' }
    await expect(providerFetch('https://api.example.com/v1', {}, { lookup: pub })).rejects.toThrow(/redirected; the redirect was not followed/)
  })
  it('a disallowed port never reaches the transport', async () => {
    await expect(providerFetch('https://api.example.com:8443/v1', {}, { lookup: pub })).rejects.toThrow('The AI provider base URL is not allowed.')
    expect(h.seen).toBeNull()
  })
  it('providerRequest hands a 401 back to the caller; providerFetch turns it into a status-only error', async () => {
    h.reply = { status: 401, headers: {}, body: 'bad key sk-secret' }
    expect((await providerRequest('https://api.example.com/v1', {}, { lookup: pub })).status).toBe(401)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(providerFetch('https://api.example.com/v1', {}, { lookup: pub })).rejects.toThrow('The AI provider answered with an error (HTTP 401).')
    expect(JSON.stringify(err.mock.calls)).not.toMatch(/sk-secret|bad key/)
    err.mockRestore()
  })
})
