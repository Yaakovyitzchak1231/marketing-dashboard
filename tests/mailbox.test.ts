/**
 * TAP-114: 1:1 emails from a connected Outlook on the lead profile.
 * The Graph response shape below is the shape Graph returned for
 * GET /me/messages?$search="participants:..." on a real mailbox (Oct 13, 2026),
 * with the addresses replaced.
 */
import { describe, expect, it, vi } from 'vitest'
import { directionOf, leadAddresses, mergeMessages, normalizeEmail } from '@/lib/mailbox/match'
import { addressFromIdToken, authorizeUrl, messagesWith, OUTLOOK_SCOPES, refreshAccess, searchUrl, toMailboxMessage, type Fetcher } from '@/lib/mailbox/outlook'
import { decodeStateCookie, encodeStateCookie, stateMatches } from '@/lib/mailbox/oauth-state'
import { settingSpec, settingsByGroup } from '@/lib/settings/registry'

vi.mock('server-only', () => ({}))

const ME = 'Owner@Example.co'
const LEAD = 'jane@lead.io'

const g = (address: string) => ({ emailAddress: { address, name: address } })
const graphPage = {
  value: [
    { id: 'm3', subject: 'RE: pricing', from: g(ME), toRecipients: [g('Jane@Lead.io')], ccRecipients: [], sentDateTime: '2026-10-13T15:11:52Z', receivedDateTime: '2026-10-13T15:11:53Z', bodyPreview: 'Thanks Jane,\r\n  see below', webLink: 'https://outlook.office365.com/owa/?ItemID=m3', conversationId: 'c1', isDraft: false },
    { id: 'm2', subject: 'pricing', from: g('jane@lead.io'), toRecipients: [g(ME)], ccRecipients: [], sentDateTime: '2026-10-13T14:50:34Z', receivedDateTime: '2026-10-13T14:50:35Z', bodyPreview: 'Hi', webLink: 'javascript:alert(1)', conversationId: 'c1', isDraft: false },
    { id: 'd1', subject: 'draft', from: g(ME), toRecipients: [g(LEAD)], ccRecipients: [], sentDateTime: null, receivedDateTime: '2026-10-13T10:00:00Z', bodyPreview: '', webLink: null, conversationId: 'c2', isDraft: true },
    { id: 'x1', subject: 'fwd: someone else', from: g('bob@other.com'), toRecipients: [g(ME)], ccRecipients: [], sentDateTime: '2026-10-12T10:00:00Z', receivedDateTime: '2026-10-12T10:00:01Z', bodyPreview: 'jane@lead.io mentioned', webLink: null, conversationId: 'c3', isDraft: false },
    { id: 'm1', subject: 'intro', from: g(ME), toRecipients: [g('team@lead.io')], ccRecipients: [g('JANE@lead.io')], sentDateTime: '2026-10-11T09:00:00Z', receivedDateTime: '2026-10-11T09:00:01Z', bodyPreview: 'Hello', webLink: null, conversationId: 'c4', isDraft: false },
  ],
  '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skiptoken=abc',
}

function fakeFetch(handler: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => { status: number; body: unknown }): Fetcher & { calls: { url: string; init: { method: string; headers: Record<string, string>; body?: string } }[] } {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body?: string } }[] = []
  const f = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, init })
    const r = handler(url, init)
    return { status: r.status, text: async () => JSON.stringify(r.body) }
  }) as Fetcher & { calls: typeof calls }
  f.calls = calls
  return f
}

describe('matching', () => {
  it('normalizes and validates addresses', () => {
    expect(normalizeEmail('  Jane@Lead.IO ')).toBe('jane@lead.io')
    expect(normalizeEmail('not an email')).toBeNull()
    expect(normalizeEmail('a"b@x.com')).toBeNull()
    expect(leadAddresses(['A@x.com', null, 'a@x.com', 'bad', 'b@y.com'])).toEqual(['a@x.com', 'b@y.com'])
  })
  it('counts only mail between the mailbox and the lead', () => {
    expect(directionOf({ from: LEAD, to: [ME], cc: [] }, ME, LEAD)).toBe('received')
    expect(directionOf({ from: ME, to: ['other@x.com'], cc: [LEAD.toUpperCase()] }, ME, LEAD)).toBe('sent')
    expect(directionOf({ from: ME, to: [LEAD], cc: [], isDraft: true }, ME, LEAD)).toBeNull()
    expect(directionOf({ from: 'bob@x.com', to: [ME], cc: [LEAD] }, ME, LEAD)).toBeNull()
    expect(directionOf({ from: ME, to: ['bob@x.com'], cc: [] }, ME, LEAD)).toBeNull()
    expect(directionOf({ from: ME, to: [ME], cc: [] }, ME, ME)).toBeNull()
  })
  it('merges, dedupes and sorts newest first', () => {
    const a = [{ provider: 'outlook', id: '1', at: '2026-10-01T00:00:00Z' }, { provider: 'outlook', id: '2', at: '2026-10-03T00:00:00Z' }]
    const b = [{ provider: 'outlook', id: '2', at: '2026-10-03T00:00:00Z' }, { provider: 'gmail', id: '2', at: '2026-10-02T00:00:00Z' }]
    const m = mergeMessages([a, b], 2)
    expect(m.messages.map((x) => `${x.provider}:${x.id}`)).toEqual(['outlook:2', 'gmail:2'])
    expect(m.truncated).toBe(true)
  })
})

describe('Outlook (Microsoft Graph)', () => {
  it('asks for read-only scopes only', () => {
    expect(OUTLOOK_SCOPES).toContain('https://graph.microsoft.com/Mail.Read')
    for (const s of OUTLOOK_SCOPES) expect(s).not.toMatch(/Send|ReadWrite|Write/i)
    const u = new URL(authorizeUrl({ clientId: 'cid', clientSecret: 's', tenant: 'common' }, 'https://dash.example/api/mailbox/outlook/callback', 'st8', 'Owner@Example.co'))
    expect(u.origin + u.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')
    expect(u.searchParams.get('scope')).toBe('openid profile email offline_access https://graph.microsoft.com/Mail.Read')
    expect(u.searchParams.get('state')).toBe('st8')
    expect(u.searchParams.get('redirect_uri')).toBe('https://dash.example/api/mailbox/outlook/callback')
    expect(u.toString()).not.toContain('secret')
  })
  it('refuses a bad tenant before any request', () => {
    expect(() => authorizeUrl({ clientId: 'c', clientSecret: 's', tenant: 'evil/../x' }, 'https://x/cb', 's')).toThrow(/tenant/)
  })
  it('builds a participants search and rejects anything that is not an address', () => {
    const u = new URL(searchUrl('Jane@Lead.io', 100))
    expect(u.pathname).toBe('/v1.0/me/messages')
    expect(u.searchParams.get('$search')).toBe('"participants:jane@lead.io"')
    expect(u.searchParams.get('$top')).toBe('100')
    expect(() => searchUrl('x" OR subject:"y', 10)).toThrow()
  })
  it('keeps only 1:1 messages, newest first, and flags more pages', async () => {
    const f = fakeFetch(() => ({ status: 200, body: graphPage }))
    const r = await messagesWith('tok', ME, LEAD, { limit: 100, fetcher: f })
    expect(f.calls[0].init.method).toBe('GET')
    expect(f.calls[0].init.headers.Authorization).toBe('Bearer tok')
    expect(r.messages.map((m) => [m.id, m.direction])).toEqual([
      ['m3', 'sent'],
      ['m2', 'received'],
      ['m1', 'sent'],
    ])
    expect(r.messages[0].preview).toBe('Thanks Jane, see below')
    expect(r.messages[0].at).toBe('2026-10-13T15:11:52Z')
    expect(r.messages[1].at).toBe('2026-10-13T14:50:35Z')
    expect(r.messages[0].webLink).toBe('https://outlook.office365.com/owa/?ItemID=m3')
    expect(r.messages[1].webLink).toBeNull()
    expect(r.truncated).toBe(true)
  })
  it('reports Graph errors in plain words', async () => {
    const f = fakeFetch(() => ({ status: 401, body: { error: { code: 'InvalidAuthenticationToken', message: 'Access token has expired.' } } }))
    await expect(messagesWith('tok', ME, LEAD, { limit: 10, fetcher: f })).rejects.toThrow('Outlook answered HTTP 401: Access token has expired.')
  })
  it('refreshes with the refresh token and refuses a token without Mail.Read', async () => {
    const ok = fakeFetch(() => ({ status: 200, body: { access_token: 'at', refresh_token: 'rt2', expires_in: 3600, scope: 'https://graph.microsoft.com/Mail.Read' } }))
    const t = await refreshAccess({ clientId: 'c', clientSecret: 's', tenant: 'common' }, 'rt1', ok)
    expect(t).toMatchObject({ accessToken: 'at', refreshToken: 'rt2', expiresInSec: 3600 })
    const body = new URLSearchParams(ok.calls[0].init.body)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('rt1')
    const wrong = fakeFetch(() => ({ status: 200, body: { access_token: 'at', scope: 'User.Read' } }))
    await expect(refreshAccess({ clientId: 'c', clientSecret: 's', tenant: 'common' }, 'rt1', wrong)).rejects.toThrow(/Mail.Read/)
    const denied = fakeFetch(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS70008: The refresh token has expired.\r\nTrace ID: x' } }))
    await expect(refreshAccess({ clientId: 'c', clientSecret: 's', tenant: 'common' }, 'rt1', denied)).rejects.toThrow('Microsoft sign-in answered HTTP 400: AADSTS70008: The refresh token has expired.')
  })
  it('reads who signed in from the id token', () => {
    const payload = Buffer.from(JSON.stringify({ preferred_username: 'Owner@Example.co' })).toString('base64url')
    expect(addressFromIdToken(`h.${payload}.s`)).toBe('owner@example.co')
    expect(addressFromIdToken('garbage')).toBeNull()
  })
  it('maps a single message', () => {
    expect(toMailboxMessage(graphPage.value[3], ME, LEAD)).toBeNull()
    expect(toMailboxMessage(graphPage.value[1], ME, LEAD)?.matched).toBe('jane@lead.io')
  })
})

describe('OAuth state cookie', () => {
  it('round-trips and compares safely', () => {
    const c = encodeStateCookie('abc', '/leads/7?tab=timeline')
    expect(decodeStateCookie(c)).toEqual({ state: 'abc', next: '/leads/7?tab=timeline' })
    expect(decodeStateCookie('%%%')).toBeNull()
    expect(stateMatches('abc', 'abc')).toBe(true)
    expect(stateMatches('abc', 'abd')).toBe(false)
    expect(stateMatches('abc', null)).toBe(false)
  })
})

describe('settings', () => {
  it('registers the Mailboxes group behind an off-by-default flag', () => {
    const group = settingsByGroup().find((x) => x.group === 'Mailboxes')
    expect(group?.items.map((i) => i.key)).toEqual([
      'mailbox.outlook.enabled',
      'mailbox.outlook.client_id',
      'mailbox.outlook.client_secret',
      'mailbox.outlook.tenant',
      'mailbox.outlook.address',
      'mailbox.outlook.refresh_token',
    ])
    expect(group?.items.every((i) => i.optional)).toBe(true)
    expect(settingSpec('mailbox.outlook.client_secret')?.secret).toBe(true)
    expect(settingSpec('mailbox.outlook.refresh_token')?.secret).toBe(true)
    expect(settingSpec('mailbox.outlook.enabled')?.options?.map((o) => o.value)).toEqual(['off', 'on'])
    expect(settingSpec('mailbox.outlook.tenant')?.validate?.('common')).toBeNull()
    expect(settingSpec('mailbox.outlook.tenant')?.validate?.('x/y')).not.toBeNull()
  })
})
