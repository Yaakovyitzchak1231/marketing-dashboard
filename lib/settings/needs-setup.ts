/**
 * "What still needs setting up" for the top of /settings. Pure: the page hands in
 * what it already loaded (saved values, secret statuses, env) and gets back the
 * list of fields that are not set, each with the anchor id its row carries.
 *
 * Set means: a secret with a saved value (status.set) or a non-empty env fallback;
 * a plain setting with a non-empty saved value or a non-empty env fallback.
 */

export interface SetupField {
  key: string
  label: string
  group: string
  secret: boolean
  envFallback?: string
  /** The saved (DB) value of a plain setting, if any. */
  value?: string | null
  /** For a secret: whether a value is saved in the settings store. */
  secretSet?: boolean
  /** Shown as optional: listed separately and not counted. */
  optional?: boolean
}

export interface SetupItem {
  key: string
  label: string
  group: string
  anchor: string
  optional: boolean
}

type Env = Record<string, string | undefined>

/** A stable, URL-safe id for a settings row: "mail.api_key" -> "setting-mail-api-key". */
export function settingAnchor(key: string): string {
  return 'setting-' + key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

export function isFieldSet(f: SetupField, env: Env = process.env): boolean {
  const fromEnv = Boolean(f.envFallback && env[f.envFallback]?.trim())
  if (fromEnv) return true
  if (f.secret) return Boolean(f.secretSet)
  return Boolean(f.value && String(f.value).trim())
}

/** Every field that is not set, in the order given (which is the page's order). */
export function needsSetup(fields: SetupField[], env: Env = process.env): SetupItem[] {
  return fields
    .filter((f) => !isFieldSet(f, env))
    .map((f) => ({ key: f.key, label: f.label, group: f.group, anchor: settingAnchor(f.key), optional: Boolean(f.optional) }))
}
