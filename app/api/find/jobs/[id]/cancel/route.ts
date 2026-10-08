import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { cancelFindJob } from '@/lib/engine/jobs'
import { OpsError } from '@/lib/ops/core'

export const dynamic = 'force-dynamic'

/** POST /api/find/jobs/:id/cancel -> { job }. The runner stops at its next item and keeps what it found. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = getDb()
  if (!db) return NextResponse.json({ error: 'database not connected' }, { status: 503 })
  const id = Number((await ctx.params).id)
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 })
  try {
    const job = await cancelFindJob(db, 'owner', id)
    if (!job) return NextResponse.json({ error: 'no such job' }, { status: 404 })
    return NextResponse.json({ job })
  } catch (e) {
    if (e instanceof OpsError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}
