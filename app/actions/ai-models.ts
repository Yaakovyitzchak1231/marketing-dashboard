'use server'

/**
 * Server action behind the AI model dropdown on /settings: asks the configured
 * OpenAI-compatible provider for its model list. Runs on the server (behind the
 * same login gate as every other settings action), so the API key never
 * reaches the browser; only model ids come back.
 */
import { resolveConfig } from '@/lib/settings/store'
import { validatePublicHttpsUrl } from '@/lib/settings/safe-url'
import { fetchModelList, type ModelListResult } from '@/lib/settings/models'

export async function listAiModelsAction(): Promise<ModelListResult> {
  try {
    const [base, key] = await Promise.all([resolveConfig('ai.base_url'), resolveConfig('ai.api_key')])
    const bad = base.value ? validatePublicHttpsUrl(base.value) : null
    if (bad) return { ok: false, message: `The AI provider base URL is not allowed: ${bad}` }
    return await fetchModelList(base.value, key.value, { timeoutMs: 6000 })
  } catch {
    return { ok: false, message: 'Could not read the AI provider settings.' }
  }
}
