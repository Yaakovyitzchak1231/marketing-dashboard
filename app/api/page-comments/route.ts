import { NextResponse } from 'next/server'
import { listMyCommentsAction } from '@/app/actions/page-comments'

/**
 * GET /api/page-comments: the comment layer's list of my comments, as a plain GET.
 *
 * The layer used to call listMyCommentsAction directly, but every server action is a POST and
 * middleware.ts refuses any POST from a viewer (403), so viewers got a console error on every
 * page. This route runs the very same action (same session, same actorFor('viewer') check, same
 * query), so nothing is loosened: it only changes the HTTP method a read travels on. The login
 * gate in middleware.ts protects it like every other /api route. Writes stay server actions.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const r = await listMyCommentsAction()
  return NextResponse.json(r, { headers: { 'Cache-Control': 'no-store' } })
}
