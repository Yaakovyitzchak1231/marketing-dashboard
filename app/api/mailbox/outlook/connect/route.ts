import { NextResponse, type NextRequest } from 'next/server'
import { actorFor } from '@/lib/auth/act'
import { authDenied } from '@/lib/auth/http'
import { safeNextPath } from '@/lib/auth/next-path'
import { authorizeUrl } from '@/lib/mailbox/outlook'
import { outlookSetup } from '@/lib/mailbox/server'
import { encodeStateCookie, newState, STATE_COOKIE, STATE_COOKIE_PATH, STATE_MAX_AGE_SEC } from '@/lib/mailbox/oauth-state'

export const dynamic = 'force-dynamic'

/**
 * Connect Outlook (TAP-114): sends the owner to Microsoft's sign-in, asking
 * for read-only mail access (Mail.Read). Owner only, because the callback
 * saves a credential into the settings store. Does nothing unless the
 * mailbox flag is on and the Microsoft app is set up.
 */
export async function GET(req: NextRequest) {
  try {
    await actorFor('owner')
  } catch (e) {
    return authDenied(e)
  }
  const setup = await outlookSetup()
  if (!setup.enabled) return plain('Outlook emails on lead pages are turned off (Settings → Mailboxes).', 404)
  if (!setup.app) return plain(`Outlook is not set up yet. Missing: ${setup.missing.join(', ')} (Settings → Mailboxes).`, 400)

  const next = safeNextPath(req.nextUrl.searchParams.get('next')) ?? '/settings'
  const state = newState()
  const redirectUri = `${req.nextUrl.origin}/api/mailbox/outlook/callback`
  const res = NextResponse.redirect(authorizeUrl(setup.app, redirectUri, state, setup.address), 302)
  res.cookies.set(STATE_COOKIE, encodeStateCookie(state, next), {
    httpOnly: true,
    secure: req.nextUrl.protocol === 'https:',
    sameSite: 'lax',
    path: STATE_COOKIE_PATH,
    maxAge: STATE_MAX_AGE_SEC,
  })
  res.headers.set('Cache-Control', 'private, no-store')
  return res
}

function plain(text: string, status: number) {
  return new NextResponse(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' } })
}
