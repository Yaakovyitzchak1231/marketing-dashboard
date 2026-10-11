import { NextResponse } from 'next/server'
import { opsGate } from '@/lib/ops/gate'
import { dispatchDue } from '@/lib/notify/deliver'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Opt-in scheduler safety net. Immediate delivery still runs after each write. */
export async function GET(req: Request) {
  const gate = await opsGate(req, { cronOnly: true, unauthorizedMessage: 'A valid scheduler credential is required.' })
  if (!gate.ok) return gate.response
  const headers = { 'Cache-Control': 'no-store' }
  if (!gate.db) return NextResponse.json({ ok: false, error: 'The database is not connected.' }, { status: 503, headers })
  try {
    const result = await dispatchDue(gate.db)
    return NextResponse.json({ ok: true, result }, { headers })
  } catch {
    return NextResponse.json({ ok: false, error: 'Delivery dispatch failed. Queued notifications are retained for retry.' }, { status: 503, headers })
  }
}
