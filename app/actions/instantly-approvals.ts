'use server'

/**
 * The human's Approve / Reject on an agent's queued Instantly change (the
 * "Needs your OK" queue on the Activity page). Runs as the signed-in human
 * behind the login gate; agents can't reach server actions. Approve needs the
 * confirm click (confirm=yes) and then runs exactly the stored change; Reject
 * needs a reason. See lib/instantly/gate.ts.
 */
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db'
import { decideInstantlyApproval } from '@/lib/instantly/gate'
import { writerFromEnv } from '@/lib/instantly/writer'
import { clearInstantlyMemo } from '@/lib/instantly/client'

const ME = 'owner'

const s = (f: FormData, k: string) => {
  const v = f.get(k)
  return typeof v === 'string' ? v.trim() : ''
}

function withNote(path: string, tone: 'good' | 'bad', text: string): string {
  const u = new URL(path, 'http://x')
  u.searchParams.set('note', text.slice(0, 300))
  u.searchParams.set('tone', tone)
  return `${u.pathname}?${u.searchParams.toString()}`
}

export async function decideInstantlyApprovalAction(f: FormData) {
  const id = Number(s(f, 'approval_id'))
  const decision = s(f, 'decision') === 'approved' ? 'approved' : 'rejected'
  let tone: 'good' | 'bad' = 'bad'
  let message: string
  const db = getDb()
  if (!db) message = 'The lead database is not connected (DATABASE_URL is not set).'
  else if (!Number.isInteger(id) || id <= 0) message = 'Unknown request.'
  else {
    try {
      const r = await decideInstantlyApproval(db, decision === 'approved' ? writerFromEnv() : null, ME, id, decision, {
        note: s(f, 'note') || null,
        confirm: s(f, 'confirm') === 'yes',
      })
      tone = r.ok ? 'good' : 'bad'
      message = r.message
      if (r.executed) clearInstantlyMemo()
    } catch (e) {
      message = (e as Error).message
    }
  }
  revalidatePath('/activity')
  revalidatePath('/leads')
  revalidatePath('/reports', 'layout')
  redirect(withNote('/activity', tone, message))
}
