/**
 * Where the dashboard finds Warmbly (TAP-118).
 *
 * - API key: `warmbly.api_key` from /settings (encrypted in lp.secrets), else
 *   the WARMBLY_API_KEY env var — the same DB-then-env rule as every other key.
 * - URL: `warmbly.url` from /settings, else WARMBLY_URL, else the public `url`
 *   of the 'warmbly' row on /tools (lp.integrations), which already points at
 *   his instance. The row's api_url (127.0.0.1) is for the OVH runner and is
 *   never used from Vercel.
 */
import 'server-only'
import { WarmblyClient } from './client.ts'
import { readWarmblySnapshot, type WarmblySnapshot } from './snapshot.ts'

export type WarmblyConfigState =
  | { state: 'ready'; client: WarmblyClient; baseUrl: string; keySource: 'db' | 'env' }
  | { state: 'no_key'; baseUrl: string | null }
  | { state: 'no_url' }

export async function warmblyConfig(env: Record<string, string | undefined> = process.env): Promise<WarmblyConfigState> {
  const { resolveConfig } = await import('../settings/store.ts')
  let baseUrl = (await resolveConfig('warmbly.url', env)).value
  if (!baseUrl) {
    try {
      const { getDb } = await import('@/lib/db')
      const db = getDb()
      if (db) {
        const { getIntegration } = await import('../integrations/store.ts')
        const row = await getIntegration(db, 'warmbly')
        if (row?.url && /^https:\/\//.test(row.url)) baseUrl = row.url
      }
    } catch {
      // no DB: fall through to no_url
    }
  }
  if (!baseUrl) return { state: 'no_url' }
  const key = await resolveConfig('warmbly.api_key', env)
  if (!key.value) return { state: 'no_key', baseUrl }
  return { state: 'ready', client: new WarmblyClient({ baseUrl, apiKey: key.value }), baseUrl, keySource: key.source === 'db' ? 'db' : 'env' }
}

export type WarmblyView =
  | { state: 'ready'; baseUrl: string; keySource: 'db' | 'env'; snapshot: WarmblySnapshot }
  | { state: 'no_key'; baseUrl: string | null }
  | { state: 'no_url' }

/** The /tools panel's data: configuration state plus one live read when configured. */
export async function loadWarmblyView(now: Date = new Date()): Promise<WarmblyView> {
  const cfg = await warmblyConfig()
  if (cfg.state !== 'ready') return cfg
  return { state: 'ready', baseUrl: cfg.baseUrl, keySource: cfg.keySource, snapshot: await readWarmblySnapshot(cfg.client, now) }
}
