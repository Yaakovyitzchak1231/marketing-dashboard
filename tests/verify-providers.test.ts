import { describe, it, expect } from 'vitest'
import { mvVerify, mvCredits, MV_VERDICT } from '@/lib/verify/millionverifier'
import { zbVerify, zbCredits, zbVerdict } from '@/lib/verify/zerobounce'
import { ProviderAccountError } from '@/lib/verify/types'
import { redactRaw, redactUrl } from '@/lib/verify/redact'
import { fakeFetch, installPaidNetworkGuard, paidCallAttempts } from './helpers/no-paid-network'

installPaidNetworkGuard()

const KEY = 'sk_TEST_ONLY_9f8e7d6c'

describe('the paid-network guard', () => {
  it('blocks a real call to MillionVerifier or ZeroBounce (and counts it)', async () => {
    await expect(fetch('https://api.millionverifier.com/api/v3/?api=x&email=a@b.com')).rejects.toThrow(/BLOCKED/)
    expect(paidCallAttempts.splice(0)).toEqual(['api.millionverifier.com'])
    await expect(fetch('https://api.zerobounce.net/v2/getcredits?api_key=x')).rejects.toThrow(/BLOCKED/)
    expect(paidCallAttempts.splice(0)).toEqual(['api.zerobounce.net'])
  })

  it('the clients fall back to global fetch, which the guard blocks, so a missing injection cannot leak', async () => {
    await expect(mvVerify('a@gemco.com', { apiKey: KEY })).rejects.toBeInstanceOf(ProviderAccountError)
    expect(paidCallAttempts.splice(0)).toEqual(['api.millionverifier.com'])
  })
})

describe('MillionVerifier client', () => {
  it.each([
    ['ok', 'valid'],
    ['catch_all', 'catch_all'],
    ['unknown', 'unknown'],
    ['disposable', 'invalid'],
    ['invalid', 'invalid'],
  ])('maps %s -> %s', async (word, verdict) => {
    const f = fakeFetch(() => ({ body: { email: 'a@gemco.com', result: word, subresult: 'x', credits: 9000, error: '' } }))
    const r = await mvVerify('a@gemco.com', { apiKey: KEY, fetch: f })
    expect(r).toMatchObject({ provider: 'millionverifier', result: word, verdict, billable: true, credits_left: 9000 })
    expect(MV_VERDICT[word]).toBe(verdict)
  })

  it('calls the documented v3 endpoint with the key, email and timeout', async () => {
    const f = fakeFetch(() => ({ body: { result: 'ok' } }))
    await mvVerify('o+1@gemco.com', { apiKey: KEY, fetch: f, timeoutSec: 10 })
    const u = new URL(f.calls[0])
    expect(u.origin + u.pathname).toBe('https://api.millionverifier.com/api/v3/')
    expect(u.searchParams.get('email')).toBe('o+1@gemco.com')
    expect(u.searchParams.get('timeout')).toBe('10')
    expect(u.searchParams.get('api')).toBe(KEY)
  })

  it('an `error` result is recorded, not billed, and leaves the verdict unknown', async () => {
    const f = fakeFetch(() => ({ body: { result: 'error', subresult: 'internal_error', error: 'Internal error' } }))
    expect(await mvVerify('a@gemco.com', { apiKey: KEY, fetch: f })).toMatchObject({ result: 'error', verdict: 'unknown', billable: false })
  })

  it('a bad key / no credits / HTTP error is an account error, and the key never appears in it', async () => {
    for (const answer of [
      { body: { error: 'Invalid API key ' + KEY } },
      { body: { error: 'Insufficient credits' } },
      { status: 401, body: {} },
    ]) {
      const f = fakeFetch(() => answer)
      const e = await mvVerify('a@gemco.com', { apiKey: KEY, fetch: f }).catch((x) => x)
      expect(e).toBeInstanceOf(ProviderAccountError)
      expect(String(e.message)).not.toContain(KEY)
      expect(JSON.stringify(e.raw ?? {})).not.toContain(KEY)
    }
  })

  it('no key -> "MillionVerifier key not set", no request made', async () => {
    const f = fakeFetch(() => ({ body: {} }))
    await expect(mvVerify('a@gemco.com', { apiKey: '', fetch: f })).rejects.toThrow('MillionVerifier key not set')
    expect(f.calls).toEqual([])
  })

  it('reads the credit balance (mocked)', async () => {
    const f = fakeFetch((u) => {
      expect(u.pathname).toBe('/api/v3/credits')
      return { body: { credits: 12345, bulk_credits: 12345 } }
    })
    expect(await mvCredits(KEY, f)).toEqual({ provider: 'millionverifier', key_set: true, credits: 12345, error: null })
    expect(await mvCredits(undefined, f)).toEqual({ provider: 'millionverifier', key_set: false, credits: null, error: null })
  })
})

describe('ZeroBounce client', () => {
  it.each([
    ['valid', null, 'valid', true],
    ['invalid', 'mailbox_not_found', 'invalid', true],
    ['catch-all', null, 'catch_all', true],
    ['unknown', 'greylisted', 'unknown', false],
    ['spamtrap', null, 'invalid', true],
    ['abuse', null, 'risky', true],
    ['do_not_mail', 'role_based', 'risky', true],
    ['do_not_mail', 'disposable', 'invalid', true],
    ['do_not_mail', 'toxic', 'invalid', true],
  ])('maps %s/%s -> %s (billable %s)', async (status, sub, verdict, billable) => {
    const f = fakeFetch(() => ({ body: { address: 'a@gemco.com', status, sub_status: sub ?? '' } }))
    expect(await zbVerify('a@gemco.com', { apiKey: KEY, fetch: f })).toMatchObject({ result: status, sub_result: sub, verdict, billable })
    expect(zbVerdict(status, sub)).toBe(verdict)
  })

  it('calls the documented v2 validate endpoint', async () => {
    const f = fakeFetch(() => ({ body: { status: 'valid' } }))
    await zbVerify('a@gemco.com', { apiKey: KEY, fetch: f })
    const u = new URL(f.calls[0])
    expect(u.origin + u.pathname).toBe('https://api.zerobounce.net/v2/validate')
    expect(u.searchParams.get('email')).toBe('a@gemco.com')
    expect(u.searchParams.has('ip_address')).toBe(true)
  })

  it('{"error": ...} is an account error', async () => {
    const f = fakeFetch(() => ({ body: { error: 'Invalid API Key or your account ran out of credits' } }))
    await expect(zbVerify('a@gemco.com', { apiKey: KEY, fetch: f })).rejects.toBeInstanceOf(ProviderAccountError)
  })

  it('reads credits; -1 means the key is invalid', async () => {
    expect(await zbCredits(KEY, fakeFetch(() => ({ body: { Credits: 2375323 } })))).toMatchObject({ credits: 2375323, error: null })
    expect(await zbCredits(KEY, fakeFetch(() => ({ body: { Credits: '42' } })))).toMatchObject({ credits: 42 })
    expect(await zbCredits(KEY, fakeFetch(() => ({ body: { Credits: -1 } })))).toMatchObject({ credits: null, error: expect.stringMatching(/invalid/) })
    expect(await zbCredits(undefined)).toMatchObject({ key_set: false, credits: null })
  })
})

describe('redaction', () => {
  it('scrubs keys from URLs, fields and nested strings', () => {
    expect(redactUrl('https://x/v2/validate?api_key=abc123&email=a')).toBe('https://x/v2/validate?api_key=REDACTED&email=a')
    expect(redactUrl('https://x/api/v3/?api=abc123&email=a')).toBe('https://x/api/v3/?api=REDACTED&email=a')
    const out = redactRaw({ api_key: KEY, nested: { msg: `bad key ${KEY}` }, list: [KEY] }, [KEY])
    expect(JSON.stringify(out)).not.toContain(KEY)
  })

  it('a provider that echoes the key back never gets it into the stored raw payload', async () => {
    const f = fakeFetch(() => ({ body: { result: 'ok', echo: `https://api.millionverifier.com/api/v3/?api=${KEY}`, api: KEY } }))
    const r = await mvVerify('a@gemco.com', { apiKey: KEY, fetch: f })
    expect(JSON.stringify(r.raw)).not.toContain(KEY)
  })
})
