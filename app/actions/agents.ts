'use server'

/**
 * Pause / resume agents from the dashboard. Owner-only (plan 1.14): each
 * action checks the role itself (actorFor) and records the signed-in owner's
 * own actor id. Agents have no ops call for it, and the database refuses a
 * pause not made by a human.
 */
import { revalidatePath } from 'next/cache'
import { getDb } from '@/lib/db'
import { pauseAgent, pauseAll, resumeAgent, resumeAll } from '@/lib/ops/pause'
import { actorFor } from '@/lib/auth/act'

function db() {
  const d = getDb()
  if (!d) throw new Error('The lead database is not connected (DATABASE_URL is not set).')
  return d
}
const s = (f: FormData, k: string) => {
  const v = f.get(k)
  return typeof v === 'string' ? v.trim() : ''
}

function refresh(id?: string) {
  revalidatePath('/agents')
  if (id) revalidatePath(`/agents/${id}`)
  revalidatePath('/activity')
}

export async function pauseAgentAction(f: FormData) {
  const ME = await actorFor('owner')
  const id = s(f, 'agent_id')
  if (s(f, 'confirm') !== 'yes') return
  await pauseAgent(db(), ME, id, s(f, 'reason') || null)
  refresh(id)
}

export async function resumeAgentAction(f: FormData) {
  const ME = await actorFor('owner')
  const id = s(f, 'agent_id')
  if (s(f, 'confirm') !== 'yes') return
  await resumeAgent(db(), ME, id)
  refresh(id)
}

export async function pauseAllAction(f: FormData) {
  const ME = await actorFor('owner')
  if (s(f, 'confirm') !== 'yes') return
  await pauseAll(db(), ME, s(f, 'reason') || null)
  refresh()
}

export async function resumeAllAction(f: FormData) {
  const ME = await actorFor('owner')
  if (s(f, 'confirm') !== 'yes') return
  await resumeAll(db(), ME)
  refresh()
}
