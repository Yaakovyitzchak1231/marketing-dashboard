/**
 * The settings store: lp.settings (non-secret, readable by agents) and
 * lp.secrets (never readable over the API, values never returned to a
 * browser). Every write records an lp.status_history row (entity_type
 * 'setting'): for a non-secret setting the real old/new value; for a secret,
 * only "set …<last4>" / "not set" — the plaintext never touches the log.
 */
import type { Db, Queryable } from '../db/types.ts'
import { decryptSecret, encryptSecret, settingsKeyConfigured, type EncryptedSecretRow } from './crypto.ts'
import { QUIET_END_KEY, QUIET_START_KEY, quietHoursPairError } from './quiet-hours.ts'
import { integrationSpecFor, settingSpec, SETTINGS_REGISTRY, type SettingSpec } from './registry.ts'
import { isOwnerActor } from '../ops/actor-role.ts'

export class SettingsError extends Error {
  readonly status: 400 | 403 | 404
  constructor(message: string, status: 400 | 403 | 404 = 400) {
    super(message)
    this.name = 'SettingsError'
    this.status = status
  }
}

type Via = 'ui' | 'ops_api'

async function isHuman(q: Queryable, actor: string): Promise<boolean> {
  const { rows } = await q.query<{ kind: string }>('select kind from lp.actors where id = $1', [actor])
  return rows[0]?.kind === 'human'
}

/** put_setting / put a secret are config changes, same bar as other admin-ish ops (pause control, campaign rules): a person only. */
export async function requireCanWriteSettings(q: Queryable, actor: string, key?: string): Promise<void> {
  if (!(await isHuman(q, actor))) {
    throw new SettingsError('Only a person can change settings. An agent can read non-secret settings with its own key.', 403)
  }
  // The AI provider settings decide where the server sends requests (and an API key): Owner only, on every path (UI and ops API).
  if (key?.startsWith('ai.') && !(await isOwnerActor(q, actor))) {
    throw new SettingsError('Only an Owner can change the AI provider settings.', 403)
  }
}

function requireKnown(key: string): SettingSpec {
  const spec = settingSpec(key)
  if (!spec) throw new SettingsError(`Unknown setting "${key}".`, 404)
  return spec
}

function requireNonSecretSpec(key: string): SettingSpec {
  const spec = requireKnown(key)
  if (spec.secret) throw new SettingsError(`"${key}" is a secret; use the Replace button, not a plain value.`, 400)
  return spec
}

function requireSecretSpec(key: string): SettingSpec {
  const spec = requireKnown(key)
  if (!spec.secret) throw new SettingsError(`"${key}" is not a secret.`, 400)
  return spec
}

/**
 * lp.status_history.entity_id is numeric; a setting's key (and an actor's id,
 * below) is a text slug, so these rows use entity_key instead and leave
 * entity_id null (0017_audit_log.sql: entity_id is nullable, entity_key text,
 * a row needs one or the other — added after this was flagged to the
 * coordinator mid-build; see memory/tapdash_schema_bug_status_history_entity_id.md
 * for the before/after).
 */
async function audit(
  q: Queryable,
  actor: string,
  opts: { key: string; field?: string; oldValue: string | null; newValue: string | null; via: Via; note?: string },
): Promise<void> {
  await q.query(
    `insert into lp.status_history (entity_type, entity_key, field, old_value, new_value, changed_by, via, note)
     values ('setting', $1, $2, $3, $4, $5, $6, $7)`,
    [opts.key, opts.field ?? opts.key, opts.oldValue, opts.newValue, actor, opts.via, opts.note ?? null],
  )
}

// --------------------------------------------------------------- non-secret

export interface SettingRow {
  key: string
  value: string
  description: string | null
  updated_by: string | null
  updated_at: string
  created_at: string
}

/** Every non-secret setting that has ever been saved (no registry defaults filled in). */
export async function listSettings(q: Queryable): Promise<SettingRow[]> {
  const { rows } = await q.query<{ key: string; value: unknown; description: string | null; updated_by: string | null; updated_at: string; created_at: string }>(
    'select key, value, description, updated_by, updated_at, created_at from lp.settings order by key',
  )
  return rows.map((r) => ({ ...r, value: unwrap(r.value) }))
}

function unwrap(value: unknown): string {
  if (typeof value === 'string') return value
  return value == null ? '' : JSON.stringify(value)
}

/** One non-secret setting's current value, or null when never saved (callers fall back to env themselves, or use resolveConfig). */
export async function getSetting(q: Queryable, key: string): Promise<string | null> {
  const { rows } = await q.query<{ value: unknown }>('select value from lp.settings where key = $1', [key])
  if (!rows[0]) return null
  return unwrap(rows[0].value)
}

async function writeSetting(q: Queryable, actor: string, key: string, v: string, opts: { via: Via; note?: string }): Promise<SettingRow> {
  const before = await getSetting(q, key)
  const { rows } = await q.query<{ key: string; value: unknown; description: string | null; updated_by: string | null; updated_at: string; created_at: string }>(
    `insert into lp.settings (key, value, updated_by) values ($1, $2::jsonb, $3)
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by
     returning key, value, description, updated_by, updated_at, created_at`,
    [key, JSON.stringify(v), actor],
  )
  if (before !== v) await audit(q, actor, { key, oldValue: before, newValue: v, via: opts.via, note: opts.note })
  return { ...rows[0], value: unwrap(rows[0].value) }
}

/**
 * Validated write of one non-secret setting. No-ops (still returns the row) when the value is unchanged.
 * The two quiet-hours keys are one range: a single-key write is refused when the pair it would leave is
 * half-set or has equal ends (use putQuietHours to set or clear both together).
 */
export async function putSetting(db: Db, actor: string, key: string, value: string, opts: { via: Via; note?: string } = { via: 'ui' }): Promise<SettingRow> {
  const spec = requireNonSecretSpec(key)
  const v = value.trim()
  const err = spec.validate?.(v)
  if (err) throw new SettingsError(err, 400)
  return db.tx(async (q) => {
    await requireCanWriteSettings(q, actor, key)
    if (key === QUIET_START_KEY || key === QUIET_END_KEY) {
      const other = await getSetting(q, key === QUIET_START_KEY ? QUIET_END_KEY : QUIET_START_KEY)
      const pairErr = key === QUIET_START_KEY ? quietHoursPairError(v, other) : quietHoursPairError(other, v)
      if (pairErr) throw new SettingsError(`${pairErr} Save the start and end together, or clear both (the Quiet hours control, or the put_quiet_hours op).`, 400)
    }
    return writeSetting(q, actor, key, v, opts)
  }, actor)
}

/** Delete one non-secret setting row (a key with no row reads back as null: unset). Audits old -> null when it held a value. */
async function deleteSetting(q: Queryable, actor: string, key: string, opts: { via: Via; note?: string }): Promise<void> {
  const before = await getSetting(q, key)
  await q.query('delete from lp.settings where key = $1', [key])
  if (before !== null) await audit(q, actor, { key, oldValue: before, newValue: null, via: opts.via, note: opts.note })
}

/**
 * Set quiet hours as one range, or clear them. To set: both required, 24-hour HH:MM, different.
 * To clear: pass both blank; both rows are deleted (so getSetting reads null, "Not set") in the
 * same transaction, each audited old -> null. Exactly one blank is refused. One transaction either
 * way, so a half-set range is never stored. Clearing also repairs a stored half-set or invalid pair.
 * Returns the saved range, or { start: '', end: '' } when cleared.
 */
export async function putQuietHours(
  db: Db,
  actor: string,
  start: string,
  end: string,
  opts: { via: Via; note?: string } = { via: 'ui' },
): Promise<{ start: string; end: string }> {
  const s = typeof start === 'string' ? start.trim() : ''
  const e = typeof end === 'string' ? end.trim() : ''
  if (!s && !e) {
    return db.tx(async (q) => {
      await requireCanWriteSettings(q, actor, QUIET_START_KEY) // both keys are workspace.*, so one check covers the pair
      await deleteSetting(q, actor, QUIET_START_KEY, opts)
      await deleteSetting(q, actor, QUIET_END_KEY, opts)
      return { start: '', end: '' }
    }, actor)
  }
  if (!s || !e) throw new SettingsError(`Quiet hours need both a start and an end (${QUIET_START_KEY} and ${QUIET_END_KEY}), or leave both blank to clear them.`, 400)
  const pairErr = quietHoursPairError(s, e)
  if (pairErr) throw new SettingsError(pairErr, 400)
  return db.tx(async (q) => {
    await requireCanWriteSettings(q, actor, QUIET_START_KEY) // both keys are workspace.*, so one check covers the pair
    await writeSetting(q, actor, QUIET_START_KEY, s, opts)
    await writeSetting(q, actor, QUIET_END_KEY, e, opts)
    return { start: s, end: e }
  }, actor)
}

// ------------------------------------------------------------------ secrets

export interface SecretStatus {
  key: string
  set: boolean
  last4: string | null
  updated_at: string | null
  updated_by: string | null
}

/** {key, set, last4, updated_at, updated_by} for one secret — never the value. */
export async function secretStatus(q: Queryable, key: string): Promise<SecretStatus> {
  requireSecretSpec(key)
  const { rows } = await q.query<{ last4: string | null; updated_at: string; updated_by: string | null }>(
    'select last4, updated_at, updated_by from lp.secrets where key = $1',
    [key],
  )
  const row = rows[0]
  return { key, set: Boolean(row), last4: row?.last4 ?? null, updated_at: row?.updated_at ?? null, updated_by: row?.updated_by ?? null }
}

/** secretStatus for every registered secret, in registry order. */
export async function listSecretStatuses(q: Queryable): Promise<SecretStatus[]> {
  const keys = SETTINGS_REGISTRY.filter((s) => s.secret).map((s) => s.key)
  const { rows } = await q.query<{ key: string; last4: string | null; updated_at: string; updated_by: string | null }>(
    'select key, last4, updated_at, updated_by from lp.secrets',
  )
  const byKey = new Map(rows.map((r) => [r.key, r]))
  return keys.map((key) => {
    const row = byKey.get(key)
    return { key, set: Boolean(row), last4: row?.last4 ?? null, updated_at: row?.updated_at ?? null, updated_by: row?.updated_by ?? null }
  })
}

/** Encrypt and save a secret. Requires SETTINGS_KEY to be configured. The UI (never the ops API) is the only door. */
export async function putSecret(db: Db, actor: string, key: string, value: string, opts: { via: Via; note?: string } = { via: 'ui' }): Promise<SecretStatus> {
  requireSecretSpec(key)
  if (!value.trim()) throw new SettingsError('Cannot be empty.', 400)
  if (!settingsKeyConfigured()) {
    throw new SettingsError('SETTINGS_KEY is not set in this deployment’s environment, so secrets cannot be saved yet. Add it in Vercel and redeploy.', 400)
  }
  const enc = encryptSecret(value.trim())
  return db.tx(async (q) => {
    await requireCanWriteSettings(q, actor, key)
    const before = await secretStatus(q, key)
    await q.query(
      `insert into lp.secrets (key, ciphertext, iv, tag, last4, updated_by) values ($1, $2, $3, $4, $5, $6)
       on conflict (key) do update set ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag, last4 = excluded.last4, updated_by = excluded.updated_by`,
      [key, enc.ciphertext, enc.iv, enc.tag, enc.last4, actor],
    )
    await audit(q, actor, {
      key,
      oldValue: before.set ? `set …${before.last4}` : null,
      newValue: `set …${enc.last4}`,
      via: opts.via,
      note: opts.note,
    })
    return secretStatus(q, key)
  }, actor)
}

/** Remove a secret entirely (soft, by deleting the row — the audit log keeps the history). */
export async function clearSecret(db: Db, actor: string, key: string, opts: { via: Via; note?: string } = { via: 'ui' }): Promise<SecretStatus> {
  requireSecretSpec(key)
  return db.tx(async (q) => {
    await requireCanWriteSettings(q, actor, key)
    const before = await secretStatus(q, key)
    if (before.set) {
      await q.query('delete from lp.secrets where key = $1', [key])
      await audit(q, actor, { key, oldValue: `set …${before.last4}`, newValue: null, via: opts.via, note: opts.note })
    }
    return secretStatus(q, key)
  }, actor)
}

/**
 * Server-only: decrypt a secret for actual use (calling Instantly, sending
 * mail…). Never exposed over the ops API — only resolveConfig and
 * consumer modules call this.
 */
export async function readSecret(q: Queryable, key: string): Promise<string | null> {
  const { rows } = await q.query<EncryptedSecretRow>('select ciphertext, iv, tag from lp.secrets where key = $1', [key])
  if (!rows[0]) return null
  return decryptSecret(rows[0])
}

// -------------------------------------------------------------- the reader

export interface ResolvedConfig {
  value: string | null
  source: 'db' | 'env' | 'unset'
}

/**
 * DB first, then env, for any registered (or lp.integrations-pattern) key —
 * secret or not. This is what lib/instantly/client.ts (and, over time,
 * lib/notify/mail.ts, lib/verify/*) read through instead of process.env
 * directly, so a value saved on /settings works the moment it is saved, and
 * an env-only deploy keeps working exactly as it does today.
 *
 * Takes just the key, like every other env read in this codebase (clientFromEnv,
 * mailConfigured, ...): it reaches the database itself through getDb(), so a
 * caller with no `db` in scope — or one that only has env — still works.
 */
export async function resolveConfig(key: string, env: Record<string, string | undefined> = process.env): Promise<ResolvedConfig> {
  const spec = settingSpec(key)
  // lib/db is a server-only module; load it on first use so this store (and
  // lib/ops/dispatch.ts, which imports SETTINGS_OPS) stays importable anywhere,
  // the same pattern dispatch.ts uses for the Instantly gate.
  let q: Queryable | null = null
  try {
    const { getDb } = await import('@/lib/db')
    q = getDb()
  } catch {
    q = null
  }
  const fromDb = q ? (spec?.secret ? await readSecret(q, key).catch(() => null) : await getSetting(q, key).catch(() => null)) : null
  if (fromDb !== null && fromDb !== undefined && fromDb !== '') return { value: fromDb, source: 'db' }
  const envName = spec?.envFallback
  const fromEnv = envName ? env[envName] : undefined
  if (fromEnv && fromEnv.trim()) return { value: fromEnv.trim(), source: 'env' }
  return { value: null, source: 'unset' }
}

// ---------------------------------------------------------------- agents UI

export interface ActorKindsRow {
  id: string
  display_name: string
  kind: string
  takes_kinds: string[]
}

/** lp.actors with their takes_kinds, for the Settings page's Agents section. */
export async function listActorKinds(q: Queryable): Promise<ActorKindsRow[]> {
  const { rows } = await q.query<ActorKindsRow>(
    `select id, display_name, kind, coalesce(takes_kinds, '{}') as takes_kinds from lp.actors where active order by kind desc, display_name`,
  )
  return rows
}

/** Which task kinds an agent picks up (empty = any). A person-only change, same bar as pausing an agent. */
export async function setActorTakesKinds(db: Db, actor: string, actorId: string, kinds: string[], opts: { via: Via; note?: string } = { via: 'ui' }): Promise<ActorKindsRow> {
  if (!(await isHuman(db, actor))) throw new SettingsError('Only a person can change which task kinds an agent takes.', 403)
  const clean = Array.from(new Set(kinds.map((k) => k.trim().toLowerCase()).filter(Boolean)))
  for (const k of clean) {
    if (!/^[a-z][a-z0-9_]{0,60}$/.test(k)) throw new SettingsError(`"${k}" is not a valid task kind (lowercase letters, digits, underscore).`, 400)
  }
  return db.tx(async (q) => {
    const { rows: before } = await q.query<{ display_name: string; kind: string; takes_kinds: string[] }>(
      `select display_name, kind, coalesce(takes_kinds, '{}') as takes_kinds from lp.actors where id = $1`,
      [actorId],
    )
    if (!before[0]) throw new SettingsError(`Unknown agent "${actorId}".`, 404)
    const { rows } = await q.query<ActorKindsRow>(
      `update lp.actors set takes_kinds = $2 where id = $1 returning id, display_name, kind, coalesce(takes_kinds, '{}') as takes_kinds`,
      [actorId, clean],
    )
    const oldKinds = before[0].takes_kinds.join(', ') || '(any)'
    const newKinds = clean.join(', ') || '(any)'
    if (oldKinds !== newKinds) {
      await q.query(
        `insert into lp.status_history (entity_type, entity_key, field, old_value, new_value, changed_by, via, note)
         values ('actor', $1, 'takes_kinds', $2, $3, $4, $5, $6)`,
        [actorId, oldKinds, newKinds, actor, opts.via, opts.note ?? null],
      )
    }
    return rows[0]
  }, actor)
}

// ------------------------------------------------------------ tools hub (lp.integrations)

export interface IntegrationSettingRow {
  id: string
  name: string
  kind: string
  apiKeyKey: string
  apiKeyStatus: SecretStatus
  apiUrlKey: string
  apiUrlValue: string | null
  apiUrlSource: 'db' | 'env' | 'unset'
}

/**
 * Every active lp.integrations row that has a settings_prefix, with its
 * <prefix>.api_key / <prefix>.api_url status — for the Settings page's
 * Integrations group. A row with no settings_prefix (a plain doc/sheet link,
 * nothing to authenticate) is skipped: there is nothing to configure here.
 */
export async function listIntegrationSettings(q: Queryable): Promise<IntegrationSettingRow[]> {
  const { rows } = await q.query<{ id: string; name: string; kind: string; settings_prefix: string | null }>(
    `select id, name, kind, settings_prefix from lp.integrations where active and settings_prefix is not null order by sort, name`,
  )
  const out: IntegrationSettingRow[] = []
  for (const r of rows) {
    const prefix = r.settings_prefix as string
    const keySpec = integrationSpecFor(prefix, r.name, 'api_key')
    const urlSpec = integrationSpecFor(prefix, r.name, 'api_url')
    const [apiKeyStatus, apiUrlRow] = await Promise.all([secretStatus(q, keySpec.key), getSetting(q, urlSpec.key)])
    out.push({
      id: r.id,
      name: r.name,
      kind: r.kind,
      apiKeyKey: keySpec.key,
      apiKeyStatus,
      apiUrlKey: urlSpec.key,
      apiUrlValue: apiUrlRow,
      apiUrlSource: apiUrlRow !== null ? 'db' : 'unset',
    })
  }
  return out
}

