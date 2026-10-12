import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))
const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }))

import { createTestDb } from './helpers/pglite-db'
import { putSetting } from '@/lib/settings/store'
import { getAiConfig } from '@/lib/campaign-profiles/suggest'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('getAiConfig reads /settings first, env as a fallback', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
    holder.db = db
  })
  afterAll(async () => {
    await db.close()
  })

  it('falls back to env when nothing is saved, and is unset with neither', async () => {
    expect(await getAiConfig({})).toBeNull()
    expect(await getAiConfig({ AI_BASE_URL: 'http://env.local/v1/', AI_MODEL: 'env-model' })).toEqual({
      baseUrl: 'http://env.local/v1', apiKey: null, model: 'env-model',
    })
  })

  it('a value saved on /settings wins over env', async () => {
    await putSetting(db, 'owner', 'ai.base_url', 'https://api.groq.com/openai/v1')
    await putSetting(db, 'owner', 'ai.model', 'llama-3.1-8b-instant')
    expect(await getAiConfig({ AI_BASE_URL: 'http://env.local/v1', AI_MODEL: 'env-model', AI_API_KEY: 'sk-env' })).toEqual({
      baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'sk-env', model: 'llama-3.1-8b-instant',
    })
  })
})
