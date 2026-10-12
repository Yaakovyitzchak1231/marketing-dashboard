import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))
const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }))

import { createTestDb } from './helpers/pglite-db'
import { putSetting, putSecret, getSetting, SettingsError } from '@/lib/settings/store'
import { assertPublicHost, createGuardedLookup, isBlockedIp, validatePublicHttpsUrl } from '@/lib/settings/safe-url'
import { callChat, resolveAiConfig } from '@/lib/campaign-profiles/suggest'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('validatePublicHttpsUrl (SSRF guard for ai.base_url)', () => {
  it.each([
    'https://api.groq.com/openai/v1',
    'https://openrouter.ai/api/v1',
    'https://8.8.8.8/v1',
    'https://[2606:4700::1111]/v1',
    'https://api.groq.com:443/openai/v1',
    'https://api.example.com:80/v1',
    'https://1.1.1.1/v1',
    'https://[64:ff9b::808:808]/v1', // NAT64 of 8.8.8.8
    'https://[2002:808:808::1]/v1', // 6to4 of 8.8.8.8
    'https://[::ffff:8.8.8.8]/v1', // IPv4-mapped 8.8.8.8
  ])('allows %s', (u) => expect(validatePublicHttpsUrl(u)).toBeNull())

  it.each([
    'http://api.groq.com/openai/v1',
    'ftp://example.com',
    'not a url',
    'https://localhost:11434/v1',
    'https://foo.localhost/v1',
    'https://printer.local/v1',
    'https://127.0.0.1/v1',
    'https://127.1/v1',
    'https://2130706433/v1',
    'https://0x7f000001/v1',
    'https://0.0.0.0/v1',
    'https://10.0.0.5/v1',
    'https://172.16.0.1/v1',
    'https://172.31.255.255/v1',
    'https://192.168.1.1/v1',
    'https://169.254.169.254/latest/meta-data',
    'https://100.64.0.1/v1',
    'https://100.104.103.48/v1',
    'https://[::1]/v1',
    'https://[::]/v1',
    'https://[fc00::1]/v1',
    'https://[fd12:3456::1]/v1',
    'https://[fe80::1]/v1',
    'https://[::ffff:127.0.0.1]/v1',
    'https://[::ffff:169.254.169.254]/v1',
    'https://user:pw@api.groq.com/v1',
  ])('refuses %s', (u) => expect(validatePublicHttpsUrl(u)).not.toBeNull())

  it('assertPublicHost refuses a hostname that resolves to a private address', async () => {
    await expect(assertPublicHost('https://evil.example.com/v1', async () => [{ address: '10.1.2.3' }])).rejects.toThrow(/non-public/)
    await expect(assertPublicHost('https://ok.example.com/v1', async () => [{ address: '93.184.216.34' }])).resolves.toBeUndefined()
  })
})

// One row per range the review asked for (and the boundary just inside/outside where it matters).
describe('isBlockedIp covers every non-public range', () => {
  it.each([
    // IPv4
    '0.0.0.0', '0.255.255.255', // 0.0.0.0/8
    '10.0.0.1', '10.255.255.255', // 10/8
    '100.64.0.0', '100.127.255.255', // 100.64/10 CGNAT
    '127.0.0.1', '127.255.255.254', // loopback
    '169.254.0.1', '169.254.169.254', // link-local + metadata
    '172.16.0.0', '172.31.255.255', // 172.16/12
    '192.0.0.0', '192.0.0.170', // 192.0.0.0/24
    '192.168.0.1', // 192.168/16
    '198.18.0.0', '198.19.255.255', // 198.18/15
    '224.0.0.1', '239.255.255.255', // 224/4 multicast
    '240.0.0.1', '255.255.255.255', // 240/4 reserved + broadcast
    // IPv6
    '::', '::1',
    'fc00::1', 'fd00::1', 'fdff:ffff::1', // fc00::/7
    'fe80::1', 'febf::1', // fe80::/10
    'fec0::1', 'feff::1', // fec0::/10 site-local
    'ff00::1', 'ff02::1', 'ffff::1', // ff00::/8 multicast
    '64:ff9b::7f00:1', '64:ff9b::127.0.0.1', '64:ff9b::a00:1', '64:ff9b::a9fe:a9fe', // NAT64 of 127.0.0.1 / 10.0.0.1 / 169.254.169.254
    '64:ff9b:1::1', '64:ff9b:1:ffff::1', // 64:ff9b:1::/48 local-use NAT64
    '2002:7f00:1::1', '2002:a00:1::', '2002:a9fe:a9fe::1', '2002:c0a8:101::1', // 6to4 of 127.0.0.1 / 10.0.0.1 / 169.254.169.254 / 192.168.1.1
    '::10.0.0.1', '::a00:1', '::7f00:1', '::192.168.1.1', // IPv4-compatible ::/96
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::ffff:0.0.0.0', '::ffff:224.0.0.1', // IPv4-mapped
    '0:0:0:0:0:ffff:7f00:1', // fully expanded mapped loopback
    '2001:db8::1', '2001::1', '100::1', // documentation / Teredo / discard
  ])('blocks %s', (ip) => expect(isBlockedIp(ip)).toBe(true))

  it.each([
    '8.8.8.8', '1.1.1.1', '93.184.216.34', '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0',
    '198.17.255.255', '198.20.0.0', '192.0.1.1', '223.255.255.255',
    '2606:4700::1111', '2a00:1450:4001::200e', '64:ff9b::808:808', '2002:808:808::1', '::ffff:8.8.8.8', '::808:808',
    '2001:4860:4860::8888',
  ])('allows %s', (ip) => expect(isBlockedIp(ip)).toBe(false))

  it('refuses anything that is not an IP literal (fail closed)', () => {
    expect(isBlockedIp('example.com')).toBe(true)
    expect(isBlockedIp('')).toBe(true)
  })

  it.each([
    'https://[ff02::1]/v1', 'https://[fec0::1]/v1', 'https://[64:ff9b::7f00:1]/v1', 'https://[64:ff9b:1::1]/v1',
    'https://[2002:7f00:1::]/v1', 'https://[::10.0.0.1]/v1', 'https://[::ffff:10.0.0.1]/v1', 'https://192.0.0.8/v1',
    'https://198.18.0.1/v1', 'https://198.19.0.1/v1', 'https://224.0.0.1/v1', 'https://240.0.0.1/v1',
  ])('validatePublicHttpsUrl refuses %s', (u) => expect(validatePublicHttpsUrl(u)).toMatch(/public address/))
})

describe('validatePublicHttpsUrl: ports are 80 or 443 only', () => {
  it.each(['https://api.example.com:8443/v1', 'https://api.example.com:11434/v1', 'https://api.example.com:8080/v1', 'https://api.example.com:22/v1', 'https://8.8.8.8:6379/v1'])(
    'refuses %s with a clear reason',
    (u) => expect(validatePublicHttpsUrl(u)).toBe('Port must be 80 or 443 (or left out); other ports are not allowed.'),
  )
  it('allows the default and explicit 443/80', () => {
    expect(validatePublicHttpsUrl('https://api.example.com/v1')).toBeNull()
    expect(validatePublicHttpsUrl('https://api.example.com:443/v1')).toBeNull()
    expect(validatePublicHttpsUrl('https://api.example.com:80/v1')).toBeNull()
  })
})

describe('createGuardedLookup (the connect-time DNS guard; mocked resolver)', () => {
  const run = (resolve: () => Promise<{ address: string; family?: number }[]>, options: object = {}) =>
    new Promise<{ err: Error | null; address?: unknown; family?: number }>((done) => {
      createGuardedLookup(resolve)('api.example.com', options, (err, address, family) => done({ err, address, family }))
    })

  it('returns exactly the address it checked (family attached)', async () => {
    const r = await run(async () => [{ address: '93.184.216.34', family: 4 }])
    expect(r).toEqual({ err: null, address: '93.184.216.34', family: 4 })
  })
  it('all:true returns the checked list', async () => {
    const r = await run(async () => [{ address: '93.184.216.34' }, { address: '2606:4700::1111' }], { all: true })
    expect(r.err).toBeNull()
    expect(r.address).toEqual([{ address: '93.184.216.34', family: 4 }, { address: '2606:4700::1111', family: 6 }])
  })
  it('honors the requested family', async () => {
    const answers = async () => [{ address: '93.184.216.34' }, { address: '2606:4700::1111' }]
    expect((await run(answers, { family: 6 })).address).toBe('2606:4700::1111')
    expect((await run(answers, { family: 4 })).address).toBe('93.184.216.34')
    expect((await run(async () => [{ address: '93.184.216.34' }], { family: 6 })).err?.message).toMatch(/no address of the requested family/)
  })
  it.each(['10.0.0.7', '127.0.0.1', '169.254.169.254', '::1', 'fe80::1', 'ff02::1', '64:ff9b::7f00:1', '2002:a00:1::', '::ffff:10.0.0.1'])(
    'rejects an answer of %s',
    async (ip) => {
      const r = await run(async () => [{ address: ip }])
      expect(r.err?.message).toBe('The AI provider host resolves to a non-public address.')
      expect(r.address).toBeUndefined()
    },
  )
  it('rejects when ANY answer is private (public + private mix)', async () => {
    const r = await run(async () => [{ address: '93.184.216.34' }, { address: '10.0.0.7' }], { all: true })
    expect(r.err?.message).toMatch(/non-public/)
  })
  it('rejects an empty answer and a resolver failure', async () => {
    expect((await run(async () => [])).err?.message).toMatch(/non-public/)
    expect((await run(async () => { throw new Error('ENOTFOUND') })).err?.message).toBe('Could not resolve the AI provider host name.')
  })
  it('resolves once per call: a rebinding resolver cannot swap the address after the check', async () => {
    const answers = [[{ address: '93.184.216.34' }], [{ address: '169.254.169.254' }]]
    const resolve = vi.fn(async () => answers.shift() ?? [])
    const first = await run(resolve)
    expect(first.address).toBe('93.184.216.34') // the address handed to connect() is the checked one
    expect(resolve).toHaveBeenCalledTimes(1)
    const second = await run(resolve) // a second resolution sees the rebound answer and is refused
    expect(second.err?.message).toMatch(/non-public/)
  })
})

describe('ai.* settings: validated and Owner-only on save', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
    holder.db = db
    await db.tx((q) => q.query(`insert into lp.actors (id, kind, display_name, harness, active, role, email) values ('izzy', 'human', 'Izzy', 'dashboard', true, 'editor', 'izzy@example.com')`), 'owner')
  })
  afterAll(async () => {
    await db.close()
  })

  it('rejects saving a private / non-https base URL and stores nothing', async () => {
    await expect(putSetting(db, 'owner', 'ai.base_url', 'https://169.254.169.254/v1')).rejects.toThrow(SettingsError)
    await expect(putSetting(db, 'owner', 'ai.base_url', 'http://api.groq.com/openai/v1')).rejects.toThrow(/https/)
    expect(await getSetting(db, 'ai.base_url')).toBeNull()
  })

  it('an Editor cannot change ai.* settings; the Owner can', async () => {
    await expect(putSetting(db, 'izzy', 'ai.model', 'llama')).rejects.toMatchObject({ status: 403 })
    vi.stubEnv('SETTINGS_KEY', Buffer.alloc(32, 7).toString('base64'))
    await expect(putSecret(db, 'izzy', 'ai.api_key', 'sk-x')).rejects.toMatchObject({ status: 403 })
    vi.unstubAllEnvs()
    await putSetting(db, 'owner', 'ai.base_url', 'https://api.groq.com/openai/v1')
    expect(await getSetting(db, 'ai.base_url')).toBe('https://api.groq.com/openai/v1')
  })

  it('a disallowed env base URL means "not configured" with a reason, never a config', async () => {
    await db.tx((q) => q.query(`delete from lp.settings where key like 'ai.%'`), 'owner')
    const r = await resolveAiConfig({ AI_BASE_URL: 'http://localhost:11434/v1', AI_MODEL: 'm' })
    expect(r.cfg).toBeNull()
    expect(r.reason).toMatch(/not allowed/)
  })
})

describe('callChat does not leak the provider error body', () => {
  const cfg = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', model: 'm' }
  const lookup = async () => [{ address: '93.184.216.34' }]

  it('shows only the HTTP status', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = (vi.fn(async () => ({ ok: false, status: 401, text: async () => 'invalid key sk-secret for org acme-internal' })) as unknown) as typeof fetch
    const p = callChat(cfg, 'sys', 'user', { fetchImpl, lookup })
    await expect(p).rejects.toThrow('The AI provider answered with an error (HTTP 401).')
    await p.catch((e: Error) => {
      expect(e.message).not.toMatch(/sk-secret|acme/)
    })
    err.mockRestore()
  })

  it('never fetches when the host resolves privately', async () => {
    const fetchImpl = vi.fn()
    await expect(callChat(cfg, 's', 'u', { fetchImpl: fetchImpl as unknown as typeof fetch, lookup: async () => [{ address: '127.0.0.1' }] })).rejects.toThrow(/non-public/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
