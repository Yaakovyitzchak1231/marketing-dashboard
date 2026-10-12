/**
 * POST /api/webhooks/triggers
 *
 * External "API" triggers (plan 3.2). The login gate already lets
 * /api/webhooks/* through; this route rejects anything whose bearer token
 * does not hash to an enabled api trigger. The token is the credential.
 *
 * Body: { token?, company_id? | contact_id? | email, payload?, dedupe_key? }
 * The token may also be sent as Authorization: Bearer.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { TriggerError, fireApiTrigger } from '@/lib/triggers/match'

export const dynamic = 'force-dynamic'

const MAX_BYTES = 100_000

function bearer(req: NextRequest): string | null {
  const auth = req.headers.get('authorization')
  const m = auth ? /^Bearer\s+(.+)$/i.exec(auth.trim()) : null
  return m?.[1]?.trim() || null
}

export async function POST(req: NextRequest) {
  const db = getDb()
  if (!db) return NextResponse.json({ ok: false, error: 'database not connected' }, { status: 503 })
  const text = await req.text()
  if (text.length > MAX_BYTES) return NextResponse.json({ ok: false, error: 'payload too large' }, { status: 413 })
  let body: Record<string, unknown> = {}
  if (text.trim()) {
    try {
      const parsed = JSON.parse(text)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return NextResponse.json({ ok: false, error: 'JSON object required' }, { status: 400 })
      }
      body = parsed as Record<string, unknown>
    } catch {
      return NextResponse.json({ ok: false, error: 'invalid JSON' }, { status: 400 })
    }
  }
  const token = bearer(req) ?? (typeof body.token === 'string' ? body.token : '')
  const companyId = body.company_id == null ? null : Number(body.company_id)
  const contactId = body.contact_id == null ? null : Number(body.contact_id)
  try {
    const result = await fireApiTrigger(db, {
      token,
      company_id: Number.isInteger(companyId) ? companyId : null,
      contact_id: Number.isInteger(contactId) ? contactId : null,
      email: typeof body.email === 'string' ? body.email : null,
      payload: body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload as Record<string, unknown> : {},
      dedupe_key: typeof body.dedupe_key === 'string' ? body.dedupe_key : null,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (e) {
    if (e instanceof TriggerError) return NextResponse.json({ ok: false, error: e.message }, { status: e.status })
    throw e
  }
}
