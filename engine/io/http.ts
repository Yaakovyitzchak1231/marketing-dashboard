/**
 * The engine's only network door. Every request has a hard deadline (the old
 * Python build hung three times on sockets with no timeout), redirects are
 * followed by hand (max 5), bodies are capped, and each request can go through
 * a different proxy from ENGINE_PROXIES (comma-separated http://user:pass@host:port
 * URLs; none set = direct). No credentials live in code.
 *
 * Built on node:http/https + CONNECT tunnelling so it needs no dependency.
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import zlib from 'node:zlib'

export const UAS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
]

export interface HttpResponse {
  status: number
  url: string
  headers: Record<string, string>
  body: string
}

export interface RequestOpts {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  maxBytes?: number
  proxy?: string | null
  maxRedirects?: number
}

export class HttpError extends Error {
  code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

function tunnel(proxy: URL, host: string, port: number, deadline: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(Number(proxy.port || 80), proxy.hostname)
    const timer = setTimeout(() => {
      sock.destroy()
      reject(new HttpError('proxy connect timed out', 'timeout'))
    }, Math.max(1, deadline - Date.now()))
    const auth = proxy.username
      ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n`
      : ''
    sock.once('error', (e) => {
      clearTimeout(timer)
      reject(new HttpError(`proxy: ${e.message}`, 'proxy'))
    })
    sock.once('connect', () => sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`))
    let buf = ''
    const onData = (d: Buffer) => {
      buf += d.toString('latin1')
      if (!buf.includes('\r\n\r\n')) return
      sock.off('data', onData)
      clearTimeout(timer)
      if (/^HTTP\/1\.[01] 200/.test(buf)) resolve(sock)
      else {
        sock.destroy()
        reject(new HttpError(`proxy refused: ${buf.split('\r\n')[0]}`, 'proxy'))
      }
    }
    sock.on('data', onData)
  })
}

async function once(target: URL, o: RequestOpts, deadline: number): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const isHttps = target.protocol === 'https:'
  const port = Number(target.port || (isHttps ? 443 : 80))
  const headers: Record<string, string> = {
    'user-agent': UAS[1],
    'accept-language': 'en-US,en;q=0.9',
    accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
    'accept-encoding': 'gzip, deflate, br',
    ...Object.fromEntries(Object.entries(o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
  }
  if (o.body != null) headers['content-length'] = String(Buffer.byteLength(o.body))
  const proxy = o.proxy ? new URL(o.proxy) : null
  let path = target.pathname + target.search
  const reqOpts: https.RequestOptions = { method: o.method ?? 'GET', headers, host: target.hostname, port, path, servername: target.hostname, rejectUnauthorized: false, agent: false }

  if (proxy) {
    if (isHttps) {
      const raw = await tunnel(proxy, target.hostname, port, deadline)
      reqOpts.createConnection = () => tls.connect({ socket: raw, servername: target.hostname, rejectUnauthorized: false })
    } else {
      path = target.href
      reqOpts.host = proxy.hostname
      reqOpts.port = Number(proxy.port || 80)
      reqOpts.path = path
      if (proxy.username) {
        headers['proxy-authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`
      }
      reqOpts.headers = { ...headers, host: target.host }
    }
  }
  const maxBytes = o.maxBytes ?? 1_500_000
  return new Promise((resolve, reject) => {
    const mod = isHttps ? https : http
    const req = mod.request(reqOpts, (res) => {
      const chunks: Uint8Array[] = []
      let size = 0
      let stream: NodeJS.ReadableStream = res
      const enc = String(res.headers['content-encoding'] ?? '').toLowerCase()
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip())
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate())
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress())
      const done = () => {
        clearTimeout(timer)
        const h: Record<string, string> = {}
        for (const [k, v] of Object.entries(res.headers)) if (v != null) h[k] = Array.isArray(v) ? v.join(', ') : String(v)
        resolve({ status: res.statusCode ?? 0, headers: h, body: Buffer.concat(chunks) })
      }
      stream.on('data', (c: Uint8Array) => {
        size += c.length
        if (size <= maxBytes) chunks.push(c)
        else {
          res.destroy()
          done()
        }
      })
      stream.on('end', done)
      stream.on('error', (e: Error) => {
        clearTimeout(timer)
        if (chunks.length) done()
        else reject(new HttpError(e.message, 'decode'))
      })
    })
    const timer = setTimeout(() => {
      req.destroy(new HttpError('timed out', 'timeout'))
    }, Math.max(1, deadline - Date.now()))
    req.on('error', (e: Error) => {
      clearTimeout(timer)
      reject(e instanceof HttpError ? e : new HttpError(e.message, (e as NodeJS.ErrnoException).code ?? 'network'))
    })
    if (o.body != null) req.write(o.body)
    req.end()
  })
}

/** One request with a whole-request deadline (default 15 s) across redirects. */
export async function request(url: string, o: RequestOpts = {}): Promise<HttpResponse> {
  const deadline = Date.now() + (o.timeoutMs ?? 15_000)
  let target = new URL(url)
  let method = o.method ?? 'GET'
  let body = o.body
  for (let hop = 0; hop <= (o.maxRedirects ?? 5); hop++) {
    if (Date.now() >= deadline) throw new HttpError('timed out', 'timeout')
    const r = await once(target, { ...o, method, body }, deadline)
    const loc = r.headers.location
    if (r.status >= 300 && r.status < 400 && loc) {
      target = new URL(loc, target)
      if (r.status !== 307 && r.status !== 308) {
        method = 'GET'
        body = undefined
      }
      continue
    }
    return { status: r.status, url: target.href, headers: r.headers, body: r.body.toString('utf8') }
  }
  throw new HttpError('too many redirects', 'redirects')
}

/** Proxy rotation: round-robin over ENGINE_PROXIES; a proxy that fails 3 times in a row rests 5 minutes. */
export class ProxyPool {
  private i = 0
  private fails = new Map<string, number>()
  private restUntil = new Map<string, number>()
  readonly proxies: string[]
  constructor(proxies: string[]) {
    this.proxies = proxies
  }
  static fromEnv(env: NodeJS.ProcessEnv = process.env): ProxyPool {
    return new ProxyPool((env.ENGINE_PROXIES ?? '').split(',').map((s) => s.trim()).filter(Boolean))
  }
  get size(): number {
    return this.proxies.length
  }
  next(): string | null {
    if (!this.proxies.length) return null
    for (let k = 0; k < this.proxies.length; k++) {
      const p = this.proxies[this.i++ % this.proxies.length]
      if ((this.restUntil.get(p) ?? 0) <= Date.now()) return p
    }
    return this.proxies[this.i++ % this.proxies.length]
  }
  report(proxy: string | null, ok: boolean): void {
    if (!proxy) return
    if (ok) {
      this.fails.set(proxy, 0)
      return
    }
    const n = (this.fails.get(proxy) ?? 0) + 1
    this.fails.set(proxy, n)
    if (n >= 3) {
      this.restUntil.set(proxy, Date.now() + 5 * 60_000)
      this.fails.set(proxy, 0)
    }
  }
}

/** Hide credentials when a proxy URL has to be named in a log or event. */
export function redactProxy(p: string | null): string {
  if (!p) return 'direct'
  try {
    const u = new URL(p)
    return `${u.protocol}//${u.hostname}:${u.port}`
  } catch {
    return 'proxy'
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/**
 * Per-host politeness: at most `perHost` requests in flight to one host and at
 * least `gapMs` between request starts. A host that answered 429 is benched
 * for `benchMs` (Shopify's 23.227.38.x range kept our IP blocked >15 min after
 * a conc-40 crawl on Oct 6).
 */
export class HostLimiter {
  private inflight = new Map<string, number>()
  private last = new Map<string, number>()
  private bench = new Map<string, number>()
  readonly perHost: number
  readonly gapMs: number
  constructor(perHost = 1, gapMs = 1000) {
    this.perHost = perHost
    this.gapMs = gapMs
  }
  benched(host: string): boolean {
    return (this.bench.get(host) ?? 0) > Date.now()
  }
  benchHost(host: string, ms: number): void {
    this.bench.set(host, Date.now() + ms)
  }
  async acquire(host: string): Promise<void> {
    for (;;) {
      const n = this.inflight.get(host) ?? 0
      const wait = (this.last.get(host) ?? 0) + this.gapMs - Date.now()
      if (n < this.perHost && wait <= 0) break
      await sleep(Math.max(50, Math.min(wait, 500)))
    }
    this.inflight.set(host, (this.inflight.get(host) ?? 0) + 1)
    this.last.set(host, Date.now())
  }
  release(host: string): void {
    this.inflight.set(host, Math.max(0, (this.inflight.get(host) ?? 1) - 1))
  }
}

/** Run fn over items with at most `conc` at once. Stops starting new items when shouldStop() turns true. */
export async function pool<T>(items: T[], conc: number, fn: (item: T) => Promise<void>, shouldStop: () => boolean = () => false): Promise<void> {
  let i = 0
  const lanes = Array.from({ length: Math.max(1, Math.min(conc, items.length)) }, async () => {
    while (i < items.length && !shouldStop()) {
      const item = items[i++]
      await fn(item)
    }
  })
  await Promise.all(lanes)
}

/** Exponential backoff with jitter: 1s, 2s, 4s ... capped. */
export function backoffMs(attempt: number, baseMs = 1000, capMs = 30_000): number {
  return Math.min(capMs, baseMs * 2 ** attempt) * (0.75 + Math.random() * 0.5)
}
