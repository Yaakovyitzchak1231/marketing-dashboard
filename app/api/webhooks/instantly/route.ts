/**
 * POST /api/webhooks/instantly
 *
 * Receives Instantly webhook events (replies, bounces, unsubscribes, sends,
 * lead labels, meetings) and writes them to the lead database. Authenticated
 * by a shared secret, INSTANTLY_WEBHOOK_SECRET, sent by Instantly as a custom
 * header on the webhook: `Authorization: Bearer <secret>` (or `x-webhook-secret`).
 * The login gate lets /api/webhooks/* through; this route rejects anything
 * without the secret.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { secretMatches } from '@/lib/ops/auth'
import { ingestInstantlyEvent, type InstantlyEvent } from '@/lib/webhooks/instantly'

export const dynamic = 'force-dynamic'

const MAX_BYTES = 1_000_000

function given(req: NextRequest): string | null {
  const auth = req.headers.get('authorization')
  const m = auth ? /^Bearer\s+(.+)$/i.exec(auth.trim()) : null
  return m?.[1]?.trim() ?? req.headers.get('x-webhook-secret')
}

export async function POST(req: NextRequest) {
  if (!secretMatches(given(req), process.env.INSTANTLY_WEBHOOK_SECRET)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const db = getDb()
  if (!db) return NextResponse.json({ ok: false, error: 'database not connected' }, { status: 503 })
  const text = await req.text()
  if (text.length > MAX_BYTES) return NextResponse.json({ ok: false, error: 'payload too large' }, { status: 413 })
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 })
  }
  const events = (Array.isArray(body) ? body : [body]).filter((x): x is InstantlyEvent => Boolean(x && typeof x === 'object'))
  if (!events.length) return NextResponse.json({ ok: false, error: 'no events' }, { status: 400 })
  try {
    const results = []
    for (const e of events.slice(0, 100)) results.push(await ingestInstantlyEvent(db, e))
    return NextResponse.json({ ok: true, results })
  } catch (e) {
    const msg = (e as Error).message
    if (msg === 'event_type is required') return NextResponse.json({ ok: false, error: msg }, { status: 400 })
    console.error('instantly webhook failed', msg)
    return NextResponse.json({ ok: false, error: 'could not store the event' }, { status: 500 })
  }
}
