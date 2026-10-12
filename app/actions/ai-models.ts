'use server'

/**
 * Server action behind the AI model dropdown on /settings: asks the configured
 * OpenAI-compatible provider for its model list. Runs on the server (behind the
 * same login gate as every other settings action), so the API key never
 * reaches the browser; only model ids come back.
 */
import { actorFor } from '@/lib/auth/act'
import { resolveConfig } from '@/lib/settings/store'
import { fetchModelList, type ModelListResult } from '@/lib/settings/models'

export async function listAiModelsAction(): Promise<ModelListResult> {
  // Owner-only: it sends the stored key to the configured host (ai.* writes are Owner-only too).
  try {
    await actorFor('owner')
  } catch {
    return { ok: false, message: 'Only the Owner can load the AI model list.' }
  }
  try {
    const [base, key] = await Promise.all([resolveConfig('ai.base_url'), resolveConfig('ai.api_key')])
    return await fetchModelList(base.value, key.value, { timeoutMs: 6000 })
  } catch {
    return { ok: false, message: 'Could not read the AI provider settings.' }
  }
}
