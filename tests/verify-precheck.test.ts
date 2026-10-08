import { describe, it, expect } from 'vitest'
import { checkSyntax, createPrechecker, precheckMany, type DnsResolver } from '@/lib/verify/precheck'
import { installPaidNetworkGuard } from './helpers/no-paid-network'

installPaidNetworkGuard()

const err = (code: string) => Object.assign(new Error(code), { code })

function fakeResolver(table: Record<string, { mx?: string[] | 'nx' | 'nodata' | 'servfail' | 'null'; a?: string[] }>) {
  const calls: string[] = []
  const r: DnsResolver = {
    async resolveMx(d) {
      calls.push(`mx:${d}`)
      const e = table[d]
      if (!e || e.mx === 'nx') throw err('ENOTFOUND')
      if (e.mx === 'nodata' || e.mx === undefined) throw err('ENODATA')
      if (e.mx === 'servfail') throw err('ESERVFAIL')
      if (e.mx === 'null') return [{ exchange: '', priority: 0 }]
      return e.mx.map((x, i) => ({ exchange: x, priority: (i + 1) * 10 }))
    },
    async resolve4(d) {
      calls.push(`a:${d}`)
      const e = table[d]
      if (e?.a?.length) return e.a
      throw err('ENODATA')
    },
    async resolve6() {
      throw err('ENODATA')
    },
  }
  return Object.assign(r, { calls })
}

describe('precheck: syntax', () => {
  it.each([
    ['owner@gemco.com', true],
    ['first.last+tag@sub.gemco.co.uk', true],
    ['no-at-sign.com', false],
    ['two@@gemco.com', false],
    ['a@b@gemco.com', false],
    ['.lead@gemco.com', false],
    ['double..dot@gemco.com', false],
    ['owner@gemco', false],
    ['owner@-gemco.com', false],
    ['owner@gemco.c', false],
    ['owner @gemco.com', false],
    ['x'.repeat(65) + '@gemco.com', false],
  ])('%s -> %s', (email, ok) => {
    expect(checkSyntax(email).ok).toBe(ok)
  })
})

describe('precheck: DNS, lists, flags', () => {
  const resolver = fakeResolver({
    'gemco.com': { mx: ['mx1.gemco.com', 'mx2.gemco.com'] },
    'gmail.com': { mx: ['gmail-smtp-in.l.google.com'] },
    'deadshop.com': { mx: 'nx' },
    'aonly.com': { mx: 'nodata', a: ['203.0.113.7'] },
    'parked.com': { mx: 'nodata' },
    'nomail.com': { mx: 'null' },
    'flaky.com': { mx: 'servfail' },
  })
  const checker = createPrechecker({ resolver })

  it('passes a normal business address with its MX hosts', async () => {
    const r = await checker.check('Owner@GemCo.com ')
    expect(r).toMatchObject({ email: 'owner@gemco.com', verdict: 'pass', result: 'ok', mx: ['mx1.gemco.com', 'mx2.gemco.com'] })
    expect(r.flags).toEqual({ role: false, free_provider: false, disposable: false, implicit_mx: false })
  })

  it('flags role and free-provider addresses but does not reject them', async () => {
    expect(await checker.check('info@gemco.com')).toMatchObject({ verdict: 'pass', flags: { role: true } })
    expect(await checker.check('jane.doe@gmail.com')).toMatchObject({ verdict: 'pass', flags: { free_provider: true } })
  })

  it('rejects a domain that does not exist, has no mail host, or publishes a null MX', async () => {
    expect(await checker.check('a@deadshop.com')).toMatchObject({ verdict: 'invalid', result: 'no_mx' })
    expect(await checker.check('a@parked.com')).toMatchObject({ verdict: 'invalid', result: 'no_mx' })
    expect(await checker.check('a@nomail.com')).toMatchObject({ verdict: 'invalid', result: 'null_mx' })
  })

  it('no MX but an A record (a website host): invalid by default, flagged; VERIFY_A_ONLY=unknown sends it to the paid tier', async () => {
    expect(await checker.check('a@aonly.com')).toMatchObject({ verdict: 'invalid', result: 'no_mx_a_only', flags: { implicit_mx: true } })
    const lenient = createPrechecker({ resolver, aOnly: 'unknown' })
    expect(await lenient.check('a@aonly.com')).toMatchObject({ verdict: 'unknown', result: 'no_mx_a_only' })
  })

  it('does not throw away an address when DNS itself fails: unknown, goes on to the paid tier', async () => {
    expect(await checker.check('a@flaky.com')).toMatchObject({ verdict: 'unknown', result: 'dns_error' })
  })

  it('rejects disposable domains and bad syntax without any DNS lookup', async () => {
    const r = fakeResolver({})
    const c = createPrechecker({ resolver: r })
    expect(await c.check('x@mailinator.com')).toMatchObject({ verdict: 'invalid', result: 'disposable', flags: { disposable: true } })
    expect(await c.check('not an email')).toMatchObject({ verdict: 'invalid', result: 'bad_syntax' })
    expect(r.calls).toEqual([])
  })

  it('looks each domain up once however many addresses share it', async () => {
    const r = fakeResolver({ 'gemco.com': { mx: ['mx.gemco.com'] } })
    const c = createPrechecker({ resolver: r })
    const out = await precheckMany(['a@gemco.com', 'b@gemco.com', 'c@gemco.com', 'd@gemco.com'], c, 4)
    expect(out.map((o) => o.verdict)).toEqual(['pass', 'pass', 'pass', 'pass'])
    expect(r.calls.filter((x) => x.startsWith('mx:'))).toEqual(['mx:gemco.com'])
    expect(c.lookups()).toBe(1)
  })

  it('times out a hung DNS lookup as unknown', async () => {
    const hang: DnsResolver = {
      resolveMx: () => new Promise(() => {}),
      resolve4: () => new Promise(() => {}),
      resolve6: () => new Promise(() => {}),
    }
    const c = createPrechecker({ resolver: hang, timeoutMs: 20 })
    expect(await c.check('a@slow.com')).toMatchObject({ verdict: 'unknown', result: 'dns_error' })
  })
})
