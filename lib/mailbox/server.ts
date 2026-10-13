import 'server-only'
/**
 * Server side of the lead-profile mailbox panel (TAP-114): reads the settings,
 * decides the panel's state, and asks each connected provider for the 1:1
 * emails with a lead's addresses. Read-only; see ./types.ts.
 *
 * Behind a flag: nothing is read, and the panel is not shown, until
 * `mailbox.outlook.enabled` is "on" (Settings → Mailboxes, or the
 * MAILBOX_OUTLOOK_ENABLED env var).
 */
import { createHash } from 'node:crypto'
import { getDb } from '@/lib/db'
import { putSecret, resolveConfig, secretStatus } from '@/lib/settings/store'
import { mergeMessages } from './match.ts'
import { messagesWith, OutlookError, refreshAccess, type OutlookAppConfig } from './outlook.ts'
import type { LeadMailboxState, MailboxMessage, ProviderResult } from './types.ts'

export const OUTLOOK_KEYS = {
  enabled: 'mailbox.outlook.enabled',
  clientId: 'mailbox.outlook.client_id',
  clientSecret: 'mailbox.outlook.client_secret',
  tenant: 'mailbox.outlook.tenant',
  refreshToken: 'mailbox.outlook.refresh_token',
  address: 'mailbox.outlook.address',
} as const

export function flagOn(v: string | null | undefined): boolean {
  return /^(on|true|1|yes)$/i.test((v ?? '').trim())
}

export interface OutlookSetup {
  enabled: boolean
  app: OutlookAppConfig | null
  /** Labels of what is missing before Connect can work. */
  missing: string[]
  connected: boolean
  address: string | null
  refreshToken: string | null
  refreshSource: 'db' | 'env' | 'unset'
}

export async function outlookSetup(): Promise<OutlookSetup> {
  const [enabled, clientId, clientSecret, tenant, refresh, address] = await Promise.all([
    resolveConfig(OUTLOOK_KEYS.enabled),
    resolveConfig(OUTLOOK_KEYS.clientId),
    resolveConfig(OUTLOOK_KEYS.clientSecret),
    resolveConfig(OUTLOOK_KEYS.tenant),
    resolveConfig(OUTLOOK_KEYS.refreshToken),
    resolveConfig(OUTLOOK_KEYS.address),
  ])
  const missing: string[] = []
  if (!clientId.value) missing.push('Microsoft app (client) ID')
  if (!clientSecret.value) missing.push('Microsoft app client secret')
  const app = missing.length ? null : { clientId: clientId.value!, clientSecret: clientSecret.value!, tenant: tenant.value || 'common' }
  return {
    enabled: flagOn(enabled.value),
    app,
    missing,
    connected: Boolean(refresh.value && address.value),
    address: address.value,
    refreshToken: refresh.value,
    refreshSource: refresh.source,
  }
}

// Short-lived caches, per server instance. Access tokens live ~60-90 min at
// Microsoft; we keep them 5 min under that. Results are cached 5 minutes,
// the same freshness the Instantly numbers use.
const accessCache = new Map<string, { token: string; until: number }>()
const resultCache = new Map<string, { at: number; value: { messages: MailboxMessage[]; truncated: boolean } }>()
const RESULT_TTL_MS = 5 * 60 * 1000
const ROTATE_AFTER_MS = 24 * 60 * 60 * 1000

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)

async function accessToken(setup: OutlookSetup, actor: string | null): Promise<string> {
  const rt = setup.refreshToken!
  const k = hash(rt)
  const hit = accessCache.get(k)
  if (hit && hit.until > Date.now()) return hit.token
  const t = await refreshAccess(setup.app!, rt)
  accessCache.set(k, { token: t.accessToken, until: Date.now() + Math.max(60, t.expiresInSec - 300) * 1000 })
  // Microsoft rotates refresh tokens. The old one keeps working until it
  // expires, so save the new one at most once a day (one audit row a day,
  // not one per page view), and only when the saved one came from the store.
  if (t.refreshToken && t.refreshToken !== rt && setup.refreshSource === 'db' && actor) {
    try {
      const db = getDb()
      if (db) {
        const st = await secretStatus(db, OUTLOOK_KEYS.refreshToken)
        const age = st.updated_at ? Date.now() - new Date(st.updated_at).getTime() : Infinity
        if (age > ROTATE_AFTER_MS) {
          await putSecret(db, actor, OUTLOOK_KEYS.refreshToken, t.refreshToken, { via: 'ui', note: 'Microsoft issued a new Outlook refresh token on a read; saved the new one.' })
        }
      }
    } catch {
      // The read still works on the current token; the save is retried on a later read.
    }
  }
  return t.accessToken
}

export const MAX_MESSAGES = 50

/**
 * The panel state for a lead with these (already normalized) addresses.
 * `actor` is the signed-in person viewing the page, used only to save a
 * rotated refresh token under their name in the audit log.
 */
export async function leadMailbox(addresses: string[], actor: string | null): Promise<LeadMailboxState> {
  const setup = await outlookSetup()
  if (!setup.enabled) return { state: 'off' }
  if (!setup.app) return { state: 'not_configured', missing: setup.missing }
  if (!setup.connected) return { state: 'not_connected' }
  if (!addresses.length) return { state: 'no_addresses' }

  const mailbox = setup.address!
  const results: ProviderResult[] = []
  const lists: MailboxMessage[][] = []
  let truncated = false
  try {
    const token = await accessToken(setup, actor)
    const per = await Promise.all(
      addresses.map(async (a) => {
        const key = `outlook:${mailbox.toLowerCase()}:${a}`
        const hit = resultCache.get(key)
        if (hit && Date.now() - hit.at < RESULT_TTL_MS) return hit.value
        const value = await messagesWith(token, mailbox, a, { limit: 100 })
        resultCache.set(key, { at: Date.now(), value })
        return value
      }),
    )
    for (const p of per) {
      lists.push(p.messages)
      truncated ||= p.truncated
    }
    const merged = mergeMessages(lists, MAX_MESSAGES)
    results.push({ provider: 'outlook', label: 'Outlook', address: mailbox, status: 'ok', messages: merged.messages, truncated: truncated || merged.truncated })
  } catch (e) {
    const msg = e instanceof OutlookError ? e.message : 'Outlook could not be read.'
    const hint = e instanceof OutlookError && (e.status === 400 || e.status === 401) ? ' Reconnect Outlook from this panel or Settings → Mailboxes.' : ''
    results.push({ provider: 'outlook', label: 'Outlook', address: mailbox, status: 'error', error: msg + hint })
  }

  const ok = results.flatMap((r) => (r.status === 'ok' ? [r.messages] : []))
  const merged = mergeMessages(ok, MAX_MESSAGES)
  const anyTruncated = results.some((r) => r.status === 'ok' && r.truncated) || merged.truncated
  return { state: 'read', results, messages: merged.messages, addresses, truncated: anyTruncated }
}
