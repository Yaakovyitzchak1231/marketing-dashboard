import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))
const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }))

import { createTestDb } from './helpers/pglite-db'
import { putSetting, putSecret, getSetting, SettingsError } from '@/lib/settings/store'
import { assertPublicHost, validatePublicHttpsUrl } from '@/lib/settings/safe-url'
import { callChat, resolveAiConfig } from '@/lib/campaign-profiles/suggest'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('validatePublicHttpsUrl (SSRF guard for ai.base_url)', () => {
  it.each([
    'https://api.groq.com/openai/v1',
    'https://openrouter.ai/api/v1',
    'https://8.8.8.8/v1',
    'https://[2606:4700::1111]/v1',
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
