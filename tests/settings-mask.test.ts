import { describe, expect, it } from 'vitest'
import { formatSetAt, last4Of, maskedTail, MIN_LEN_FOR_LAST4, secretSummary } from '@/lib/settings/mask'
import { fetchModelList, modelsUrl, parseModelList } from '@/lib/settings/models'

describe('last4Of / maskedTail', () => {
  it('returns at most the last 4 characters, trimmed', () => {
    expect(last4Of('  sk-abcdefghijklmnop1234  ')).toBe('1234')
    expect(last4Of('re_' + 'x'.repeat(40) + 'WXYZ')).toBe('WXYZ')
  })
  it('shows nothing of empty or short values', () => {
    expect(last4Of('')).toBeNull()
    expect(last4Of(null)).toBeNull()
    expect(last4Of(undefined)).toBeNull()
    expect(last4Of('a'.repeat(MIN_LEN_FOR_LAST4 - 1))).toBeNull()
    expect(last4Of('a'.repeat(MIN_LEN_FOR_LAST4))).toHaveLength(4)
  })
  it('masks: "…1234", "…" for nothing, and never more than 4 from a longer hint', () => {
    expect(maskedTail('1234')).toBe('…1234')
    expect(maskedTail(null)).toBe('…')
    expect(maskedTail('')).toBe('…')
    expect(maskedTail('abcdefgh')).toBe('…efgh')
  })
})

describe('formatSetAt', () => {
  it('formats date and time in the given timezone', () => {
    expect(formatSetAt('2026-10-11T13:56:00Z', 'America/New_York')).toBe('Oct 11, 2026, 9:56 AM')
    expect(formatSetAt(new Date('2026-10-11T13:56:00Z'), 'UTC')).toBe('Oct 11, 2026, 1:56 PM')
  })
  it('null/invalid in, null out; a bad zone name still formats', () => {
    expect(formatSetAt(null)).toBeNull()
    expect(formatSetAt('not a date')).toBeNull()
    expect(formatSetAt('2026-10-11T13:56:00Z', 'Not/AZone')).toMatch(/2026/)
  })
})

describe('secretSummary', () => {
  it('db: last 4 + set time + who', () => {
    expect(secretSummary({ source: 'db', last4: 'a1b2', at: '2026-10-11T13:56:00Z', by: 'owner', timeZone: 'America/New_York' })).toEqual({
      badge: 'Set · …a1b2',
      line: 'Set Oct 11, 2026, 9:56 AM by owner',
    })
  })
  it('env: last 4 + first seen, or an honest "not recorded"', () => {
    const s = secretSummary({ source: 'env', last4: 'WXYZ', at: '2026-10-11T13:56:00Z', timeZone: 'America/New_York' })
    expect(s.badge).toBe('From Vercel env · …WXYZ')
    expect(s.line).toBe('First seen Oct 11, 2026, 9:56 AM (env vars carry no set date)')
    expect(secretSummary({ source: 'env', last4: null, at: null }).line).toMatch(/not recorded/)
  })
  it('unset', () => {
    expect(secretSummary({ source: 'unset', last4: null, at: null })).toEqual({ badge: 'Not set', line: null })
  })
})

describe('parseModelList', () => {
  it('OpenAI shape {data:[{id}]}, sorted and de-duplicated', () => {
    expect(parseModelList({ object: 'list', data: [{ id: 'llama-3.1-8b-instant' }, { id: 'gemma2-9b-it' }, { id: 'gemma2-9b-it' }] })).toEqual([
      'gemma2-9b-it',
      'llama-3.1-8b-instant',
    ])
  })
  it('Ollama native {models:[{name}|{model}]} and bare arrays', () => {
    expect(parseModelList({ models: [{ name: 'qwen2.5:7b' }, { model: 'llama3.2:3b' }] })).toEqual(['llama3.2:3b', 'qwen2.5:7b'])
    expect(parseModelList(['b', 'a', ''])).toEqual(['a', 'b'])
  })
  it('anything else is empty', () => {
    expect(parseModelList(null)).toEqual([])
    expect(parseModelList({ error: { message: 'bad key' } })).toEqual([])
    expect(parseModelList({ data: [{ nope: 1 }, 7] })).toEqual([])
  })
  it('modelsUrl joins with exactly one slash', () => {
    expect(modelsUrl('https://api.groq.com/openai/v1/')).toBe('https://api.groq.com/openai/v1/models')
    expect(modelsUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1/models')
  })
})

describe('fetchModelList', () => {
  const res = (status: number, body: unknown) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })
  it('sends the key as a Bearer header and returns ids', async () => {
    let seen: { url: string; auth?: string } | null = null
    const r = await fetchModelList('https://api.example.com/v1', 'sk-secret-123456', {
      fetchImpl: async (url, init) => {
        seen = { url, auth: init.headers.authorization }
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm1' }] }) }
      },
    })
    expect(r).toEqual({ ok: true, models: ['m1'] })
    expect(seen).toEqual({ url: 'https://api.example.com/v1/models', auth: 'Bearer sk-secret-123456' })
  })
  it('no key: no auth header (local Ollama)', async () => {
    let auth: string | undefined = 'x'
    await fetchModelList('http://localhost:11434/v1', null, {
      fetchImpl: async (_u, init) => {
        auth = init.headers.authorization
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm' }] }) }
      },
    })
    expect(auth).toBeUndefined()
  })
  it('plain-word errors that never echo the key', async () => {
    const key = 'sk-secret-should-not-appear'
    const cases = [
      await fetchModelList(null, key),
      await fetchModelList('not a url', key),
      await fetchModelList('https://x/v1', key, { fetchImpl: res(401, {}) }),
      await fetchModelList('https://x/v1', key, { fetchImpl: res(500, {}) }),
      await fetchModelList('https://x/v1', key, { fetchImpl: res(200, { data: [] }) }),
      await fetchModelList('https://x/v1', key, {
        fetchImpl: async () => {
          throw new Error(`boom ${key}`)
        },
      }),
      await fetchModelList('https://x/v1', key, {
        fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } }),
      }),
    ]
    for (const c of cases) {
      expect(c.ok).toBe(false)
      if (!c.ok) expect(c.message).not.toContain(key)
    }
    expect(cases[2]).toEqual({ ok: false, message: 'The provider rejected the API key. Check the AI provider API key.' })
  })
  it('times out', async () => {
    const r = await fetchModelList('https://x/v1', null, {
      timeoutMs: 20,
      fetchImpl: (_u, init) =>
        new Promise((_res, rej) => {
          init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        }),
    })
    expect(r).toEqual({ ok: false, message: 'The provider did not answer in time.' })
  })
})
