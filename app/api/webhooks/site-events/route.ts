/**
 * POST /api/webhooks/site-events
 *
 * Site tracking endpoint: records page_visited / form_submitted lead events
 * (lib/events/web.ts). The site's tracking snippet (or a server-side
 * integration) posts here; the lead is resolved by email, company_id or
 * contact_id, exactly like every other emitter.
 *
 * Authenticated by a shared secret, SITE_EVENTS_SECRET, sent as
 * `Authorization: Bearer <secret>` (or `x-webhook-secret`) — the same shape
 * as the Instantly webhook. The login gate lets /api/webhooks/* through;
 * this route rejects anything without the secret.
 *
 * Body (JSON): { type: 'page_visited' | 'form_submitted',
 *   email? | company_id? | contact_id?, url?, page_title?, referrer?,
 *   form_id?, form_name? (form_submitted needs one of these),
 *   campaign_id?, occurred_at?, dedupe_key? }
 */
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { secretMatches } from '@/lib/ops/auth'
import { emitPageVisited, emitFormSubmitted } from '@/lib/events/web'
import { evaluateCompositeRules } from '@/lib/events/composite'
import { EventError } from '@/lib/events/emit'

export const dynamic = 'force-dynamic'

const MAX_BYTES = 100_000
const TYPES = new Set(['page_visited', 'form_submitted'])

function given(req: NextRequest): string | null {
  const auth = req.headers.get('authorization')
  const m = auth ? /^Bearer\s+(.+)$/i.exec(auth.trim()) : null
  return m?.[1]?.trim() ?? req.headers.get('x-webhook-secret')
}

const num = (v: unknown): number | null => {
  const n = Number(v)
  return v != null && v !== '' && Number.isInteger(n) && n > 0 ? n : null
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

export async function POST(req: NextRequest) {
  if (!secretMatches(given(req), process.env.SITE_EVENTS_SECRET)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const db = getDb()
  if (!db) return NextResponse.json({ ok: false, error: 'database not connected' }, { status: 503 })
  const text = await req.text()
  if (text.length > MAX_BYTES) return NextResponse.json({ ok: false, error: 'payload too large' }, { status: 413 })
  let body: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 })
  }
  const type = str(body.type)
  if (!type || !TYPES.has(type)) {
    return NextResponse.json({ ok: false, error: 'type must be page_visited or form_submitted' }, { status: 400 })
  }
  const input = {
    company_id: num(body.company_id),
    contact_id: num(body.contact_id),
    email: str(body.email),
    campaign_id: num(body.campaign_id),
    url: str(body.url),
    page_title: str(body.page_title),
    referrer: str(body.referrer),
    form_id: str(body.form_id),
    form_name: str(body.form_name),
    occurred_at: str(body.occurred_at),
    dedupe_key: str(body.dedupe_key),
  }
  try {
    const r =
      type === 'page_visited' ? await emitPageVisited(db, input) : await emitFormSubmitted(db, input)
    if (r.inserted && r.id != null) {
      await evaluateCompositeRules(db, {
        id: r.id,
        type: r.type,
        company_id: r.company_id,
        contact_id: r.contact_id,
        campaign_id: input.campaign_id,
      })
    }
    return NextResponse.json({ ok: true, inserted: r.inserted, id: r.id, type: r.type })
  } catch (e) {
    if (e instanceof EventError) return NextResponse.json({ ok: false, error: e.message }, { status: 400 })
    console.error('site-events webhook failed', (e as Error).message)
    return NextResponse.json({ ok: false, error: 'could not store the event' }, { status: 500 })
  }
}
