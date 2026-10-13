/**
 * Every setting and secret the dashboard knows about: key, label, where it shows
 * up, whether it is a secret, and which env var it falls back to while the DB
 * has no row (so a Vercel-env-only deploy keeps working exactly as it does
 * today). Adding a new setting is adding one entry here.
 */
import { validatePublicHttpsUrl } from './safe-url.ts'

export type SettingGroup = 'Workspace' | 'Email sending' | 'Sending' | 'Verification' | 'AI' | 'Google' | 'Mailboxes' | 'Webhooks' | 'Integrations'

export const SETTING_GROUPS: SettingGroup[] = ['Workspace', 'Email sending', 'Sending', 'Verification', 'AI', 'Google', 'Mailboxes', 'Webhooks', 'Integrations']

/** One plain line under a group's heading on /settings, where the group needs explaining. */
export const SETTING_GROUP_HELP: Partial<Record<SettingGroup, string>> = {
  'Email sending':
    'The dashboard emails a notice the moment something needs attention, like a new page comment or a task handed to an agent. It sends through a free Resend or Brevo account. Settings values are used first, with Vercel environment variables as fallback. Until all three mail settings are available, the emails wait, then go out once they are.',
  Mailboxes:
    'Shows your own 1:1 emails with a lead on that lead’s page (Timeline tab), read live from your Outlook. Read-only: the dashboard can only list mail, never send, move or delete it, and stores no message text. Turn it on, add the Microsoft app ID and secret, then press Connect Outlook on any lead’s Timeline tab.',
}

export interface SettingOption {
  value: string
  label: string
}

export interface SettingSpec {
  key: string
  label: string
  group: SettingGroup
  secret: boolean
  /** The env var this value falls back to while no DB row exists. */
  envFallback?: string
  help?: string
  placeholder?: string
  multiline?: boolean
  /** A fixed set of choices: the field renders as a dropdown and only these values are accepted. */
  options?: SettingOption[]
  /** Not needed for the dashboard to work (shown as optional in the Needs setup list, not counted). */
  optional?: boolean
  /** Returns an error message, or null when the value is fine. Non-secret fields only get this in the UI; secrets validate on their own shape (non-empty) only, since their real shape is the provider's business. */
  validate?: (value: string) => string | null
  /** Has a "Test" button on the settings page. Keyed the same as here so store/ops can look it up. */
  testable?: boolean
}

function nonEmpty(value: string): string | null {
  return value.trim() ? null : 'Cannot be empty.'
}

function isTimezone(value: string): string | null {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value.trim() })
    return null
  } catch {
    return `"${value}" is not a timezone name (e.g. America/New_York).`
  }
}

function isHHMM(value: string): string | null {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(value.trim()) ? null : 'Use 24-hour HH:MM, e.g. 21:00.'
}

function isUrl(value: string): string | null {
  try {
    const u = new URL(value.trim())
    return u.protocol === 'http:' || u.protocol === 'https:' ? null : 'Must start with http:// or https://.'
  } catch {
    return 'That does not look like a URL.'
  }
}

function isSheetId(value: string): string | null {
  return /^[A-Za-z0-9_-]{20,100}$/.test(value.trim()) ? null : 'That does not look like a Google Sheet id (the long id in the sheet’s URL).'
}

function isEmail(value: string): string | null {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? null : 'That does not look like an email address.'
}

function isTenant(value: string): string | null {
  return /^(common|organizations|consumers|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9.-]+\.[a-z]{2,})$/i.test(value.trim())
    ? null
    : 'Use "common", "organizations", or your directory (tenant) id.'
}

export const MAIL_PROVIDER_OPTIONS: SettingOption[] = [
  { value: 'resend', label: 'Resend' },
  { value: 'brevo', label: 'Brevo' },
]

export const SETTINGS_REGISTRY: SettingSpec[] = [
  // ---------------------------------------------------------------- Workspace
  {
    key: 'workspace.timezone',
    label: 'Workspace timezone',
    group: 'Workspace',
    secret: false,
    envFallback: 'DASHBOARD_TZ',
    placeholder: 'America/New_York',
    help: 'Which timezone "today" and every date on the dashboard are shown in.',
    validate: isTimezone,
  },
  {
    key: 'workspace.date_format',
    label: 'Date format',
    group: 'Workspace',
    secret: false,
    placeholder: 'MMM D, YYYY',
    help: 'How dates are written on the dashboard, e.g. "Oct 11, 2026".',
    validate: nonEmpty,
  },
  {
    key: 'workspace.quiet_hours_start',
    label: 'Quiet hours start',
    group: 'Workspace',
    secret: false,
    placeholder: '21:00',
    help: 'No emails go out between these hours, in your timezone; a campaign can override.',
    validate: isHHMM,
  },
  {
    key: 'workspace.quiet_hours_end',
    label: 'Quiet hours end',
    group: 'Workspace',
    secret: false,
    placeholder: '08:00',
    help: 'No emails go out between these hours, in your timezone; a campaign can override.',
    validate: isHHMM,
  },
  // ------------------------------------------------------------ Email sending
  {
    key: 'mail.provider',
    label: 'Mail provider',
    group: 'Email sending',
    secret: false,
    envFallback: 'MAIL_PROVIDER',
    options: MAIL_PROVIDER_OPTIONS,
    help: 'The service that sends these emails. Pick the one you have an account with.',
    validate: (v) => (MAIL_PROVIDER_OPTIONS.some((o) => o.value === v.trim().toLowerCase()) ? null : 'Pick Resend or Brevo.'),
  },
  {
    key: 'mail.api_key',
    label: 'Mail API key',
    group: 'Email sending',
    secret: true,
    envFallback: 'MAIL_API_KEY',
    help: 'The API key from your Resend or Brevo account (whichever you picked in Mail provider). Find it in that account under API Keys.',
  },
  {
    key: 'mail.from',
    label: 'Mail sender',
    group: 'Email sending',
    secret: false,
    envFallback: 'MAIL_FROM',
    placeholder: 'Dashboard <alerts@yourdomain.com>',
    help: 'Who the emails say they are from. Use an address your Resend or Brevo account is allowed to send from.',
    validate: nonEmpty,
  },
  // ------------------------------------------------------------------ Sending
  {
    key: 'instantly.api_key',
    label: 'Instantly API key',
    group: 'Sending',
    secret: true,
    envFallback: 'INSTANTLY_API_KEY',
    help: 'Reads campaigns, accounts and replies live from Instantly (all:read is enough).',
    testable: true,
  },
  {
    key: 'warmbly.url',
    label: 'Warmbly URL',
    group: 'Sending',
    secret: false,
    envFallback: 'WARMBLY_URL',
    placeholder: 'https://your-warmbly-host',
    help: 'Where the self-hosted Warmbly instance lives, e.g. https://ovh-hermes.taila95862.ts.net. Empty: the Warmbly row on /tools is used.',
    validate: isUrl,
  },
  {
    key: 'warmbly.api_key',
    label: 'Warmbly API key',
    group: 'Sending',
    secret: true,
    envFallback: 'WARMBLY_API_KEY',
    help: 'A read-only Warmbly API key (Warmbly → Settings → API keys, "Read only" preset). Shows mailboxes, warm-up and campaigns on /tools; it cannot send.',
    testable: true,
  },
  // ------------------------------------------------------------- Verification
  {
    key: 'millionverifier.api_key',
    label: 'MillionVerifier API key',
    group: 'Verification',
    secret: true,
    envFallback: 'MILLIONVERIFIER_API_KEY',
    help: 'Used by the verification waterfall.',
  },
  {
    key: 'zerobounce.api_key',
    label: 'ZeroBounce API key',
    group: 'Verification',
    secret: true,
    envFallback: 'ZEROBOUNCE_API_KEY',
    help: 'Used by the verification waterfall.',
  },
  {
    key: 'verify.a_only',
    label: 'No-MX (A record only) domains',
    group: 'Verification',
    secret: false,
    envFallback: 'VERIFY_A_ONLY',
    options: [
      { value: 'invalid', label: 'Treat as invalid (free)' },
      { value: 'unknown', label: 'Send to paid tier' },
    ],
    optional: true,
  },
  // --------------------------------------------------------------------- AI
  {
    key: 'ai.base_url',
    label: 'AI provider base URL',
    group: 'AI',
    secret: false,
    envFallback: 'AI_BASE_URL',
    placeholder: 'https://api.groq.com/openai/v1',
    help: 'Any OpenAI-compatible chat endpoint over https on a public host: Groq’s free tier, OpenRouter’s free models, etc. Local and private addresses are refused. Used for AI-assisted campaign-profile setup.',
    validate: validatePublicHttpsUrl,
  },
  {
    key: 'ai.api_key',
    label: 'AI provider API key',
    group: 'AI',
    secret: true,
    envFallback: 'AI_API_KEY',
    optional: true,
    help: 'Optional for a local Ollama; required for a hosted free tier.',
  },
  {
    key: 'ai.model',
    label: 'AI model',
    group: 'AI',
    secret: false,
    envFallback: 'AI_MODEL',
    placeholder: 'llama-3.1-8b-instant',
    help: 'The model name to send to the endpoint above.',
    validate: nonEmpty,
  },
  // ---------------------------------------------------------------- Google
  {
    key: 'google.lead_master_sheet_id',
    label: 'Lead Master sheet id',
    group: 'Google',
    secret: false,
    envFallback: 'LEAD_MASTER_SHEET_ID',
    help: 'The Google Sheet the Lead Master export writes its read-only tab to.',
    validate: isSheetId,
  },
  {
    key: 'google.service_account_json',
    label: 'Google service account JSON',
    group: 'Google',
    secret: true,
    envFallback: 'GOOGLE_SERVICE_ACCOUNT_JSON',
    multiline: true,
    help: 'A service account with Editor access to the sheets above (preferred over a short-lived access token).',
  },
  // ---------------------------------------------------------------- Mailboxes
  {
    key: 'mailbox.outlook.enabled',
    label: 'Show Outlook emails on lead pages',
    group: 'Mailboxes',
    secret: false,
    envFallback: 'MAILBOX_OUTLOOK_ENABLED',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'on', label: 'On' },
    ],
    optional: true,
    help: 'The feature flag. Off (the default) hides the panel and reads nothing.',
  },
  {
    key: 'mailbox.outlook.client_id',
    label: 'Microsoft app (client) ID',
    group: 'Mailboxes',
    secret: false,
    envFallback: 'MS_GRAPH_CLIENT_ID',
    placeholder: '00000000-0000-0000-0000-000000000000',
    optional: true,
    help: 'From the app registration in Microsoft Entra (portal.azure.com → App registrations). Delegated permission: Mail.Read only.',
  },
  {
    key: 'mailbox.outlook.client_secret',
    label: 'Microsoft app client secret',
    group: 'Mailboxes',
    secret: true,
    envFallback: 'MS_GRAPH_CLIENT_SECRET',
    optional: true,
    help: 'The secret’s Value (not its ID), from the same app registration → Certificates & secrets.',
  },
  {
    key: 'mailbox.outlook.tenant',
    label: 'Microsoft tenant',
    group: 'Mailboxes',
    secret: false,
    envFallback: 'MS_GRAPH_TENANT',
    placeholder: 'common',
    optional: true,
    help: 'Leave empty for "common". Use your directory (tenant) id if the app is single-tenant.',
    validate: isTenant,
  },
  {
    key: 'mailbox.outlook.address',
    label: 'Connected Outlook address',
    group: 'Mailboxes',
    secret: false,
    optional: true,
    help: 'Filled in by Connect Outlook with the account that signed in.',
    validate: isEmail,
  },
  {
    key: 'mailbox.outlook.refresh_token',
    label: 'Outlook connection',
    group: 'Mailboxes',
    secret: true,
    optional: true,
    help: 'Saved by Connect Outlook (encrypted). Clear it to disconnect.',
  },
  // -------------------------------------------------------------- Webhooks
  {
    key: 'instantly.webhook_secret',
    label: 'Instantly webhook secret',
    group: 'Webhooks',
    secret: true,
    envFallback: 'INSTANTLY_WEBHOOK_SECRET',
    help: 'The shared secret Instantly sends back on every webhook call, so /api/webhooks/instantly knows the request is really from Instantly.',
  },
]

export const SETTINGS_BY_KEY: Record<string, SettingSpec> = Object.fromEntries(SETTINGS_REGISTRY.map((s) => [s.key, s]))

/**
 * lp.integrations rows (the tools hub — Listmonk, Miniflux, changedetection.io,
 * Umami, Warmbly, ...) each get a `settings_prefix` instead of a fixed registry
 * entry, since the set of tools is data, not code. Any key shaped
 * `<prefix>.api_key` / `<prefix>.api_url` is treated as a settings-store key the
 * same way a registered one is: the first is a secret, the second is a plain
 * URL. `listIntegrationSpecs` in ./store.ts turns live lp.integrations rows into
 * SettingSpecs using this same pattern, for the Settings page's Integrations group.
 */
const INTEGRATION_KEY_RE = /^[a-z][a-z0-9_.]{0,79}\.(api_key|api_url)$/

export function integrationSpecFor(prefix: string, label: string, suffix: 'api_key' | 'api_url'): SettingSpec {
  return {
    key: `${prefix}.${suffix}`,
    label: suffix === 'api_key' ? `${label} API key` : `${label} API URL`,
    group: 'Integrations',
    secret: suffix === 'api_key',
    validate: suffix === 'api_url' ? isUrl : undefined,
  }
}

/** A generic fallback spec for a `<prefix>.api_key` / `<prefix>.api_url` key with no live lp.integrations row behind it — still shaped correctly (secret vs not) so the store doesn't refuse it as "unknown". */
function patternSpec(key: string): SettingSpec | undefined {
  const m = INTEGRATION_KEY_RE.exec(key)
  if (!m) return undefined
  const suffix = m[1] as 'api_key' | 'api_url'
  const prefix = key.slice(0, -(suffix.length + 1))
  return integrationSpecFor(prefix, prefix, suffix)
}

export function settingSpec(key: string): SettingSpec | undefined {
  return SETTINGS_BY_KEY[key] ?? patternSpec(key)
}

export function settingsByGroup(): { group: SettingGroup; items: SettingSpec[] }[] {
  return SETTING_GROUPS.map((group) => ({ group, items: SETTINGS_REGISTRY.filter((s) => s.group === group) }))
}
