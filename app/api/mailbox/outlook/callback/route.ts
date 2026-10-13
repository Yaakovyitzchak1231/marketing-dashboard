import { NextResponse, type NextRequest } from 'next/server'
import { actorFor } from '@/lib/auth/act'
import { authDenied } from '@/lib/auth/http'
import { getDb } from '@/lib/db'
import { exchangeCode, OutlookError } from '@/lib/mailbox/outlook'
import { OUTLOOK_KEYS, outlookSetup } from '@/lib/mailbox/server'
import { decodeStateCookie, stateMatches, STATE_COOKIE, STATE_COOKIE_PATH } from '@/lib/mailbox/oauth-state'
import { putSecret, putSetting, SettingsError } from '@/lib/settings/store'

export const dynamic = 'force-dynamic'

/**
 * Microsoft sends the owner back here after Connect Outlook. Checks the state
 * cookie, trades the code for tokens, and saves the refresh token (encrypted,
 * lp.secrets) and the signed-in address (lp.settings) under the owner's own
 * actor id, so the audit log names who connected it. Owner only.
 */
export async function GET(req: NextRequest) {
  let actor: string
  try {
    actor = await actorFor('owner')
  } catch (e) {
    return authDenied(e)
  }
  const sp = req.nextUrl.searchParams
  const saved = decodeStateCookie(req.cookies.get(STATE_COOKIE)?.value)
  if (!saved || !stateMatches(saved.state, sp.get('state'))) {
    return plain('This sign-in link is stale or was not started here. Press Connect Outlook again.', 400)
  }
  if (sp.get('error')) {
    const desc = (sp.get('error_description') ?? sp.get('error') ?? '').split('\r\n')[0].slice(0, 300)
    return plain(`Microsoft did not connect Outlook: ${desc}`, 400)
  }
  const code = sp.get('code')
  if (!code) return plain('Microsoft sent no sign-in code. Press Connect Outlook again.', 400)

  const setup = await outlookSetup()
  if (!setup.enabled || !setup.app) return plain('Outlook emails on lead pages are off or not set up (Settings → Mailboxes).', 400)
  const db = getDb()
  if (!db) return plain('The lead database is not connected, so the connection cannot be saved.', 500)

  try {
    const redirectUri = `${req.nextUrl.origin}/api/mailbox/outlook/callback`
    const t = await exchangeCode(setup.app, code, redirectUri)
    if (!t.refreshToken) return plain('Microsoft did not return a long-lived token (offline_access). Check the app registration’s permissions and try again.', 400)
    if (!t.address) return plain('Microsoft did not say which account signed in, so nothing was saved.', 400)
    await putSecret(db, actor, OUTLOOK_KEYS.refreshToken, t.refreshToken, { via: 'ui', note: `Connected Outlook ${t.address} (read-only, Mail.Read)` })
    await putSetting(db, actor, OUTLOOK_KEYS.address, t.address, { via: 'ui', note: 'Connect Outlook' })
  } catch (e) {
    if (e instanceof OutlookError || e instanceof SettingsError) return plain(e.message, 400)
    throw e
  }
  const res = NextResponse.redirect(new URL(saved.next, req.nextUrl.origin), 302)
  res.cookies.set(STATE_COOKIE, '', { path: STATE_COOKIE_PATH, maxAge: 0 })
  res.headers.set('Cache-Control', 'private, no-store')
  return res
}

function plain(text: string, status: number) {
  const res = new NextResponse(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' } })
  res.cookies.set(STATE_COOKIE, '', { path: STATE_COOKIE_PATH, maxAge: 0 })
  return res
}
