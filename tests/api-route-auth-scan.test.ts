import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

/**
 * Every state-changing API handler must authenticate on its own.
 *
 * Middleware only checks that the caller is signed in and blocks viewers; it
 * does not know which role a route needs, and it does not record who acted.
 * A route that skips the check lets an editor do owner-only work (the verify
 * routes did) or writes the audit trail under a made-up actor. So: every
 * exported POST / PUT / PATCH / DELETE handler under app/api must call
 * `actorFor(` (a signed-in person, at a named role) or `opsGate(` (an agent
 * bearer token) in its own body, or in a helper it calls in the same file.
 *
 * A route may authenticate some other way only if it is listed in SELF_AUTH
 * below with a one-line reason, and the test re-checks that the file really
 * contains the credential check it claims.
 */

const API_DIR = path.join(process.cwd(), 'app', 'api')
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'] as const
const AUTH_CALL = /\b(actorFor|opsGate)\s*\(/

/** Routes that do not use actorFor/opsGate, with why that is safe and the check the file must contain. */
const SELF_AUTH: Record<string, { why: string; mustContain: RegExp }> = {
  'webhooks/instantly/route.ts': {
    why: 'Instantly webhook: rejects (401) any request without the shared INSTANTLY_WEBHOOK_SECRET, compared in constant time.',
    mustContain: /secretMatches\(given\(req\), process\.env\.INSTANTLY_WEBHOOK_SECRET\)/,
  },
  'webhooks/site-events/route.ts': {
    why: 'Server-to-server site events: rejects (401) any request without the shared SITE_EVENTS_SECRET, compared in constant time.',
    mustContain: /secretMatches\(given\(req\), process\.env\.SITE_EVENTS_SECRET\)/,
  },
  'webhooks/triggers/route.ts': {
    why: 'API triggers: fireApiTrigger throws 401 unless the bearer token hashes to an enabled lp.triggers row (lib/triggers/match.ts).',
    mustContain: /fireApiTrigger\(/,
  },
  'auth/logout/route.ts': {
    why: 'Signs out only the caller\'s own session cookie; it reads and changes no dashboard data, and a signed-out caller has nothing to lose.',
    mustContain: /supabase\.auth\.signOut\(\)/,
  },
}

// ---------------------------------------------------------------------------
// A small source scanner: enough to find each exported handler's body.

/** Blank out comments and the insides of string/template literals, keeping offsets and braces outside strings. */
function stripNoise(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' '
        i++
      }
    } else if (c === '/' && n === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      out += '  '
      i += 2
    } else if (c === '"' || c === "'" || c === '`') {
      const q = c
      out += q
      i++
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') {
          out += '  '
          i += 2
        } else {
          out += src[i] === '\n' ? '\n' : ' '
          i++
        }
      }
      out += q
      i++
    } else {
      out += c
      i++
    }
  }
  return out
}

function matching(src: string, open: number, o: string, c: string): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++
    else if (src[i] === c && --depth === 0) return i
  }
  return -1
}

interface Handler {
  method: string
  body: string | null
  fns: Map<string, Fn>
}

interface Fn {
  name: string
  body: string
}

/** Every `function name(...) {...}` and `const name = [async] (...) => {...}` in the (stripped) source, plus `const a = b` aliases. */
function declaredFunctions(src: string): { fns: Map<string, Fn>; aliases: Map<string, string> } {
  const fns = new Map<string, Fn>()
  const aliases = new Map<string, string>()
  for (const m of src.matchAll(/\bfunction\s+(\w+)\s*\(/g)) {
    const open = (m.index as number) + m[0].length - 1
    const close = matching(src, open, '(', ')')
    const bodyOpen = src.indexOf('{', close)
    if (close < 0 || bodyOpen < 0) continue
    const bodyClose = matching(src, bodyOpen, '{', '}')
    fns.set(m[1], { name: m[1], body: src.slice(bodyOpen, bodyClose + 1) })
  }
  for (const m of src.matchAll(/\bconst\s+(\w+)\s*(?::[^=]+)?=\s*(async\s*)?\(/g)) {
    const open = (m.index as number) + m[0].length - 1
    const close = matching(src, open, '(', ')')
    const arrow = src.indexOf('=>', close)
    if (close < 0 || arrow < 0) continue
    const rest = src.slice(arrow + 2).trimStart()
    const start = src.length - rest.length
    const end = rest.startsWith('{') ? matching(src, start, '{', '}') : src.indexOf('\n', start)
    fns.set(m[1], { name: m[1], body: src.slice(start, end < 0 ? src.length : end + 1) })
  }
  for (const m of src.matchAll(/\bconst\s+(\w+)\s*=\s*(\w+)\s*(?:;|\n)/g)) aliases.set(m[1], m[2])
  return { fns, aliases }
}

/** Names of the exported mutating handlers in a route file, resolved to their body text; or an error string if one cannot be found. */
function mutatingHandlers(source: string): Handler[] {
  const src = stripNoise(source)
  const { fns, aliases } = declaredFunctions(src)
  const found: Handler[] = []
  for (const method of MUTATING) {
    const fnDecl = new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\s*\\(`).test(src)
    const constDecl = new RegExp(`export\\s+const\\s+${method}\\b`).test(src)
    const listed = new RegExp(`export\\s*\\{[^}]*\\b${method}\\b[^}]*\\}`).test(src)
    if (!fnDecl && !constDecl && !listed) continue
    let name: string = method
    if (aliases.has(method)) name = aliases.get(method) as string
    found.push({ method, body: fns.get(name)?.body ?? null, fns })
  }
  return found
}

/** Does this handler call actorFor/opsGate itself, or via a function declared in the same file (followed transitively)? */
function authenticates(body: string, fns: Map<string, Fn>, seen = new Set<string>()): boolean {
  if (AUTH_CALL.test(body)) return true
  for (const m of body.matchAll(/\b(\w+)\s*\(/g)) {
    const callee = m[1]
    const fn = fns.get(callee)
    if (fn && !seen.has(callee)) {
      seen.add(callee)
      if (authenticates(fn.body, fns, seen)) return true
    }
  }
  return false
}

function routeFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...routeFiles(full))
    else if (name === 'route.ts') out.push(full)
  }
  return out.sort()
}

const rel = (f: string) => path.relative(API_DIR, f).split(path.sep).join('/')

describe('the scanner itself', () => {
  it('flags a mutating handler with no auth call', () => {
    const h = mutatingHandlers(`export async function POST(req: Request) { return Response.json({ ok: true }) }`)
    expect(h).toHaveLength(1)
    expect(authenticates(h[0].body as string, h[0].fns)).toBe(false)
  })

  it('accepts actorFor and opsGate in the body, and ignores GET', () => {
    const src = `
      export async function GET() { return Response.json({}) }
      export async function PATCH(req: Request) { const actor = await actorFor('editor'); return Response.json({ actor }) }
      export async function DELETE(req: Request) { const g = await opsGate(req); return Response.json({ g }) }`
    const h = mutatingHandlers(src)
    expect(h.map((x) => x.method)).toEqual(['PATCH', 'DELETE'])
    expect(h.every((x) => authenticates(x.body as string, x.fns))).toBe(true)
  })

  it('does not count a mention in a comment or a string', () => {
    const src = `// actorFor('owner') goes here
      export async function POST() { const s = "actorFor("; /* opsGate( */ return Response.json({ s }) }`
    const h = mutatingHandlers(src)
    expect(authenticates(h[0].body as string, h[0].fns)).toBe(false)
  })

  it('follows export const X = helper aliases and same-file helpers', () => {
    const src = `
      async function handle(req: Request) { const actor = await actorFor('editor'); return Response.json({ actor }) }
      export const POST = handle
      export const PUT = handle
      export function DELETE(req: Request) { return handle(req) }
      export const PATCH = async (req: Request) => { return Response.json({}) }`
    const byMethod = Object.fromEntries(mutatingHandlers(src).map((x) => [x.method, authenticates(x.body as string, x.fns)]))
    expect(byMethod).toEqual({ POST: true, PUT: true, DELETE: true, PATCH: false })
  })

  it('reports a handler it cannot resolve instead of passing it', () => {
    const h = mutatingHandlers(`export { somethingElse as POST }\nexport const PUT = imported`)
    expect(h.every((x) => x.body === null)).toBe(true)
  })
})

describe('every mutating API route authenticates', () => {
  const files = routeFiles(API_DIR)

  it('finds the route files and the verify routes among them', () => {
    expect(files.length).toBeGreaterThan(40)
    const names = files.map(rel)
    for (const r of ['verify/preview/route.ts', 'verify/runs/[id]/approve/route.ts', 'verify/runs/[id]/step/route.ts', 'verify/runs/[id]/cancel/route.ts']) {
      expect(names).toContain(r)
    }
  })

  const missing: string[] = []
  const unresolved: string[] = []
  const allowlistedSeen = new Set<string>()
  let checked = 0
  for (const f of files) {
    const name = rel(f)
    const handlers = mutatingHandlers(readFileSync(f, 'utf8'))
    if (SELF_AUTH[name] && handlers.length) allowlistedSeen.add(name)
    for (const h of handlers) {
      if (SELF_AUTH[name]) continue
      checked++
      if (h.body === null) unresolved.push(`${name} ${h.method}`)
      else if (!authenticates(h.body, h.fns)) missing.push(`${name} ${h.method}`)
    }
  }

  it('scans a real number of handlers', () => {
    expect(checked).toBeGreaterThan(30)
  })

  it('has no mutating handler without actorFor( or opsGate(', () => {
    expect(missing, `Add \`actorFor('<role>')\` as the first thing in each handler (or opsGate for agent routes). Only a route that verifies a signed secret or token belongs in SELF_AUTH, with a reason.`).toEqual([])
  })

  it('can read every handler it checks (no handler it could not find)', () => {
    expect(unresolved).toEqual([])
  })

  it.each(Object.entries(SELF_AUTH))('SELF_AUTH entry %s is real, still mutating, and still checks its credential', (name, entry) => {
    expect(entry.why.length).toBeGreaterThan(20)
    const file = path.join(API_DIR, name)
    const src = readFileSync(file, 'utf8')
    expect(mutatingHandlers(src).length, `${name} has no mutating handler; remove it from SELF_AUTH`).toBeGreaterThan(0)
    expect(stripNoise(src)).toMatch(entry.mustContain)
  })

  it('SELF_AUTH lists no route that already uses actorFor/opsGate (it would hide a regression)', () => {
    for (const name of Object.keys(SELF_AUTH)) {
      expect(AUTH_CALL.test(stripNoise(readFileSync(path.join(API_DIR, name), 'utf8'))), name).toBe(false)
    }
  })

  it("no route passes the literal 'owner' as an actor (it hides who really acted)", () => {
    const offenders: string[] = []
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n')
      lines.forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '')
        const cleaned = code.replace(/actorFor\('owner'\)/g, '').replace(/===\s*'owner'/g, '')
        if (/['"]owner['"]/.test(cleaned)) offenders.push(`${rel(f)}:${i + 1}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('actorFor in a verify mutating route is the first awaited call in the handler', () => {
    for (const r of ['verify/preview/route.ts', 'verify/runs/[id]/approve/route.ts', 'verify/runs/[id]/step/route.ts', 'verify/runs/[id]/cancel/route.ts']) {
      const src = stripNoise(readFileSync(path.join(API_DIR, r), 'utf8'))
      const body = mutatingHandlers(src)[0].body as string
      const firstAwait = body.search(/\bawait\b/)
      expect(body.indexOf("actorFor("), `${r}`).toBeGreaterThan(-1)
      expect(body.indexOf('actorFor('), `${r}: actorFor must come before any other await`).toBeLessThan(firstAwait + 'await '.length + 1)
      expect(body.indexOf('actorFor('), `${r}: actorFor must come before dbOrNull/readJson`).toBeLessThan(Math.min(...['dbOrNull(', 'readJson(', 'parseRunId('].map((t) => (body.indexOf(t) < 0 ? Infinity : body.indexOf(t)))))
    }
  })
})
