/**
 * Settings ops for agents (POST /api/ops {op, ...} via lib/ops/dispatch.ts).
 * Agents can read non-secret settings with their own key; secrets never come
 * back over this door at all (no op returns a value, only set/last4). Writing
 * a setting over the ops API is the same bar as pausing an agent or changing
 * a campaign's rules: a signed-in person only (see requireCanWriteSettings in
 * ./store.ts, which put_setting runs through).
 */
import type { Db } from '../db/types.ts'
import { OpsError } from '../ops/core.ts'
import { getSetting, listIntegrationSettings, listSecretStatuses, listSettings, putQuietHours, putSetting, secretStatus, SettingsError } from './store.ts'
import { settingSpec, settingsByGroup } from './registry.ts'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

function key(a: Args): string {
  const k = typeof a.key === 'string' ? a.key.trim() : ''
  if (!k) throw new OpsError('key is required')
  return k
}

/** SettingsError -> OpsError with the same status, so the ops route answers 400/403/404 (the campaigns/ops.ts pattern). */
function wrap(run: Op['run']): Op['run'] {
  return async (db, actor, a) => {
    try {
      return await run(db, actor, a)
    } catch (e) {
      if (e instanceof SettingsError) throw new OpsError(e.message, e.status)
      throw e
    }
  }
}

const RAW: Record<string, Op> = {
  list_settings: {
    args: '{}  -> every registered setting grouped by section (plus a live Integrations section from lp.integrations), each with its current value (non-secret) or set/last4 (secret) — never a secret value',
    run: async (db) => {
      const [settings, secrets, integrations] = await Promise.all([listSettings(db), listSecretStatuses(db), listIntegrationSettings(db)])
      const byKey = new Map(settings.map((s) => [s.key, s]))
      const secretByKey = new Map(secrets.map((s) => [s.key, s]))
      const groups = settingsByGroup().map(({ group, items }) => ({
        group,
        items: items.map((spec) => ({
          key: spec.key,
          label: spec.label,
          secret: spec.secret,
          env_fallback: spec.envFallback ?? null,
          ...(spec.secret
            ? {
                set: secretByKey.get(spec.key)?.set ?? false,
                last4: secretByKey.get(spec.key)?.last4 ?? null,
                updated_at: secretByKey.get(spec.key)?.updated_at ?? null,
                updated_by: secretByKey.get(spec.key)?.updated_by ?? null,
              }
            : { value: byKey.get(spec.key)?.value ?? null, updated_at: byKey.get(spec.key)?.updated_at ?? null, updated_by: byKey.get(spec.key)?.updated_by ?? null }),
        })),
      }))
      if (integrations.length) {
        groups.push({
          group: 'Integrations',
          items: integrations.flatMap((i) => [
            { key: i.apiKeyKey, label: `${i.name} API key`, secret: true, env_fallback: null, set: i.apiKeyStatus.set, last4: i.apiKeyStatus.last4, updated_at: i.apiKeyStatus.updated_at, updated_by: i.apiKeyStatus.updated_by },
            { key: i.apiUrlKey, label: `${i.name} API URL`, secret: false, env_fallback: null, value: i.apiUrlValue, updated_at: null, updated_by: null },
          ]),
        })
      }
      return groups
    },
  },
  get_setting: {
    args: '{key}  -> the value of one non-secret setting, or null when never saved. Refused for a secret key or an unknown key.',
    run: async (db, _actor, a) => {
      const k = key(a)
      const spec = settingSpec(k)
      if (!spec) throw new OpsError(`Unknown setting "${k}".`, 404)
      if (spec.secret) throw new OpsError(`"${k}" is a secret; use secret_status instead.`, 403)
      return { key: k, value: await getSetting(db, k) }
    },
  },
  put_setting: {
    args: '{key, value}  -- non-secret settings only; a person only (an agent can propose a value by asking in the activity feed)',
    run: (db, actor, a) => putSetting(db, actor, key(a), String(a.value ?? ''), { via: 'ops_api' }),
  },
  put_quiet_hours: {
    args: '{start, end}  -- workspace quiet hours as one range, 24-hour HH:MM, both required and different; pass both as "" (or null) to clear them (no workspace quiet hours); a person only. put_setting on one key is refused when it would leave a half-set range',
    run: (db, actor, a) => {
      // Clearing is deliberate: both keys must be present (may be "" or null), so a call with the args forgotten cannot silently switch quiet hours off.
      if (!('start' in a) || !('end' in a)) throw new OpsError('put_quiet_hours needs both start and end. To clear quiet hours, pass both as "".', 400)
      return putQuietHours(db, actor, String(a.start ?? ''), String(a.end ?? ''), { via: 'ops_api' })
    },
  },
  secret_status: {
    args: '{key}  -> {key, set, last4, updated_at, updated_by} — never the secret value',
    run: (db, _actor, a) => secretStatus(db, key(a)),
  },
}

export const SETTINGS_OPS: Record<string, Op> = Object.fromEntries(Object.entries(RAW).map(([k, v]) => [k, { args: v.args, run: wrap(v.run) }]))
