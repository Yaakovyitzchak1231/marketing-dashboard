/**
 * Env-backed secrets on /settings: last 4 characters and the time the
 * dashboard first saw the current value (lp.env_secret_seen, 0023). Only the
 * 4 characters and the timestamp leave this module; the value never does.
 */
import { createHash } from 'node:crypto'
import type { Queryable } from '../db/types.ts'
import { last4Of } from './mask.ts'

export interface EnvSecretSeen {
  envName: string
  last4: string | null
  firstSeenAt: string | null
}

/** 16 hex chars of sha256: enough to notice a changed value, useless for recovering it. */
export function fingerprintOf(value: string): string {
  return createHash('sha256').update(value.trim(), 'utf8').digest('hex').slice(0, 16)
}

/**
 * For each env var name that holds a value: record (or refresh, when the value
 * changed) its first-seen row and return {last4, firstSeenAt}. Never throws:
 * if the table is missing (migration not applied yet) firstSeenAt is null.
 */
export async function recordEnvSecretsSeen(
  q: Queryable,
  envNames: string[],
  env: Record<string, string | undefined> = process.env,
): Promise<Map<string, EnvSecretSeen>> {
  const out = new Map<string, EnvSecretSeen>()
  for (const envName of [...new Set(envNames)]) {
    const value = env[envName]?.trim()
    if (!value) continue
    let firstSeenAt: string | null = null
    try {
      const fp = fingerprintOf(value)
      const { rows } = await q.query<{ first_seen_at: string | Date }>(
        `insert into lp.env_secret_seen (env_name, fingerprint) values ($1, $2)
         on conflict (env_name) do update
           set fingerprint = excluded.fingerprint,
               first_seen_at = case when lp.env_secret_seen.fingerprint = excluded.fingerprint then lp.env_secret_seen.first_seen_at else now() end
         returning first_seen_at`,
        [envName, fp],
      )
      const at = rows[0]?.first_seen_at
      firstSeenAt = at ? new Date(at).toISOString() : null
    } catch {
      firstSeenAt = null
    }
    out.set(envName, { envName, last4: last4Of(value), firstSeenAt })
  }
  return out
}
