import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { getFindJob, measuredEta } from '@/lib/engine/jobs'

export const dynamic = 'force-dynamic'

/** GET /api/find/jobs/:id -> { job, eta: { seconds, basis } | null } */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = getDb()
  if (!db) return NextResponse.json({ error: 'database not connected' }, { status: 503 })
  const id = Number((await ctx.params).id)
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 })
  const job = await getFindJob(db, id)
  if (!job) return NextResponse.json({ error: 'no such job' }, { status: 404 })
  return NextResponse.json({ job, eta: measuredEta(job) })
}
