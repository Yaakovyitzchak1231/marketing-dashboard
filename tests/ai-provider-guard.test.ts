// #98 review round 2: every AI provider fetch (suggest, segments "Describe it", the
// /settings model list) goes through one guard: https/public host, DNS check, no
// redirects, status-only errors. Env AI_BASE_URL is validated like a saved value.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))
const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }))

import { createTestDb } from './helpers/pglite-db'
import { providerFetch, AiProviderError } from '@/lib/settings/ai-provider'
import { fetchModelList } from '@/lib/settings/models'
import { callChat as segmentChat, resolveSegmentAiConfig, segmentFromText } from '@/lib/segments/ai'
import { callChat as suggestChat } from '@/lib/campaign-profiles/suggest'

const pub = async () => [{ address: '93.184.216.34' }]
const priv = async () => [{ address: '10.0.0.7' }]
const cfg = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-secret', model: 'm' }
const asFetch = (f: unknown) => f as typeof fetch

describe('providerFetch (the shared guard)', () => {
  it('asks fetch not to follow redirects and refuses a 3xx', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/' } }))
    await expect(providerFetch('https://api.example.com/v1/models', {}, { fetchImpl, lookup: pub })).rejects.toThrow(/redirected; the redirect was not followed/)
    expect(fetchImpl).toHaveBeenCalledWith('https://api.example.com/v1/models', expect.objectContaining({ redirect: 'manual' }))
  })
  it('refuses a disallowed URL or a private DNS answer without fetching', async () => {
    const fetchImpl = vi.fn()
    await expect(providerFetch('http://api.example.com/v1', {}, { fetchImpl, lookup: pub })).rejects.toBeInstanceOf(AiProviderError)
    await expect(providerFetch('https://api.example.com/v1', {}, { fetchImpl, lookup: priv })).rejects.toThrow(/non-public/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('segments "Describe it" uses the guard', () => {
  it('never fetches when the host resolves privately', async () => {
    const fetchImpl = vi.fn()
    await expect(segmentChat(cfg, 's', 'u', { fetchImpl: asFetch(fetchImpl), lookup: priv })).rejects.toThrow(/non-public/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('never fetches a private base URL', async () => {
    const fetchImpl = vi.fn()
    await expect(segmentChat({ ...cfg, baseUrl: 'https://192.168.1.4/v1' }, 's', 'u', { fetchImpl: asFetch(fetchImpl), lookup: pub })).rejects.toThrow(/not allowed/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('shows only the HTTP status, never the provider body or key', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(async () => new Response('bad key sk-secret org acme-internal', { status: 401 }))
    const e = await segmentChat(cfg, 's', 'u', { fetchImpl: asFetch(fetchImpl), lookup: pub }).catch((x: Error) => x)
    expect((e as Error).message).toBe('The AI provider answered with an error (HTTP 401).')
    expect((e as Error).message).not.toMatch(/sk-secret|acme/)
    // The server log gets the status and a fixed reason code, never the provider body or the key.
    expect(err).toHaveBeenCalledWith('AI provider error', { status: 401, reason: 'http_error' })
    expect(JSON.stringify(err.mock.calls)).not.toMatch(/sk-secret|acme|bad key/)
    err.mockRestore()
  })
  it('does not follow a redirect', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 307, headers: { location: 'https://10.0.0.1/' } }))
    await expect(segmentChat(cfg, 's', 'u', { fetchImpl: asFetch(fetchImpl), lookup: pub })).rejects.toThrow(/not followed/)
  })
})

describe('provider errors never reach the log or the client with their text', () => {
  it('an unreachable host logs only a fixed code, not the (address-bearing) error text', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:443 sk-secret'), { code: 'ECONNREFUSED' })
    })
    const e = await providerFetch('https://api.example.com/v1', {}, { fetchImpl, lookup: pub }).catch((x: Error) => x)
    expect((e as Error).message).toBe('Could not reach the AI provider.')
    expect(err).toHaveBeenCalledWith('AI provider unreachable', { reason: 'unreachable', code: 'ECONNREFUSED' })
    expect(JSON.stringify(err.mock.calls)).not.toMatch(/10\.1\.2\.3|sk-secret/)
    err.mockRestore()
  })
  it('a 5xx body is not read into the error, the client message or the log (suggest callChat too)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchImpl = vi.fn(async () => new Response('stack trace /srv/app/secret.ts token=abc123', { status: 502 }))
    const e = await suggestChat(cfg, 's', 'u', { fetchImpl: asFetch(fetchImpl), lookup: pub }).catch((x: Error) => x)
    expect((e as Error).message).toBe('The AI provider answered with an error (HTTP 502).')
    expect(JSON.stringify(err.mock.calls)).not.toMatch(/stack trace|abc123|secret\.ts/)
    err.mockRestore()
  })
})

describe('suggest callChat does not follow redirects', () => {
  it('refuses a 3xx', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 301, headers: { location: 'https://127.0.0.1/' } }))
    await expect(suggestChat(cfg, 's', 'u', { fetchImpl: asFetch(fetchImpl), lookup: pub })).rejects.toThrow(/not followed/)
  })
})

describe('env AI_BASE_URL is validated', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  beforeAll(async () => {
    db = await createTestDb()
    holder.db = db
  })
  afterAll(async () => {
    await db.close()
  })
  it('an invalid env base URL is "not configured" with a reason (segments)', async () => {
    const r = await resolveSegmentAiConfig({ AI_BASE_URL: 'https://169.254.169.254/v1', AI_MODEL: 'm' })
    expect(r.cfg).toBeNull()
    expect(r.reason).toMatch(/not allowed/)
  })
  it('segmentFromText reports the reason and does not call the model', async () => {
    vi.stubEnv('AI_BASE_URL', 'http://localhost:11434/v1')
    vi.stubEnv('AI_MODEL', 'm')
    const chat = vi.fn()
    const r = await segmentFromText('opened twice', { chat })
    vi.unstubAllEnvs()
    expect(r).toMatchObject({ configured: false, reason: expect.stringMatching(/not allowed/) })
    expect(chat).not.toHaveBeenCalled()
  })
  it('a valid env base URL is used', async () => {
    const r = await resolveSegmentAiConfig({ AI_BASE_URL: 'https://api.groq.com/openai/v1/', AI_MODEL: 'm' })
    expect(r.cfg).toEqual({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: null, model: 'm' })
  })
})

describe('model list fetch', () => {
  it('refuses a host that resolves privately, without fetching', async () => {
    const fetchImpl = vi.fn()
    const r = await fetchModelList('https://models.example.com/v1', 'k', { fetchImpl, lookup: priv })
    expect(r).toEqual({ ok: false, message: expect.stringMatching(/non-public/) })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('does not follow a redirect', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 302, json: async () => ({}) }))
    const r = await fetchModelList('https://models.example.com/v1', 'k', { fetchImpl, lookup: pub })
    expect(r).toEqual({ ok: false, message: 'The AI provider redirected; the redirect was not followed.' })
    expect(fetchImpl).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: 'manual' }))
  })
})
