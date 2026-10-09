'use server'

/**
 * The dashboard's door into the co-working layer. Same functions the agents
 * call through /api/ops, run as the signed-in human ('owner'). The login gate
 * in middleware.ts protects these (server actions post to page routes).
 */
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db'
import {
  claimTask, comment, createTask, decideApproval, handoffTask, markRead, memoryDelete, memoryPut, releaseLock, sendMessage, updateTask,
} from '@/lib/ops/core'
import { kickDelivery } from '@/lib/notify/kick'

const ME = 'owner'

function db() {
  const d = getDb()
  if (!d) throw new Error('The lead database is not connected (DATABASE_URL is not set).')
  return d
}
const s = (f: FormData, k: string) => {
  const v = f.get(k)
  return typeof v === 'string' ? v.trim() : ''
}
const n = (f: FormData, k: string) => {
  const v = Number(s(f, k))
  return Number.isFinite(v) && v > 0 ? v : null
}

export async function createTaskAction(f: FormData) {
  const t = await createTask(db(), ME, {
    title: s(f, 'title'),
    body: s(f, 'body') || null,
    assigned_to: s(f, 'assigned_to') || null,
    project_id: n(f, 'project_id'),
    company_id: n(f, 'company_id'),
    priority: s(f, 'priority') ? Number(s(f, 'priority')) : undefined,
    kind: s(f, 'kind') || 'general',
  })
  // The assignee hears about it now (webhook / email / ping), not when it next checks the board.
  kickDelivery(db())
  revalidatePath('/team')
  revalidatePath('/agents', 'layout')
  const back = s(f, 'return_to')
  redirect(back && back.startsWith('/') ? back : `/team/${t.id}`)
}

export async function commentAction(f: FormData) {
  const taskId = n(f, 'task_id')
  await comment(db(), ME, { task_id: taskId, company_id: n(f, 'company_id'), body: s(f, 'body') })
  kickDelivery(db())
  if (taskId) revalidatePath(`/team/${taskId}`)
}

export async function handoffAction(f: FormData) {
  const id = n(f, 'task_id')!
  await handoffTask(db(), ME, id, { to: s(f, 'to'), note: s(f, 'note') })
  kickDelivery(db())
  revalidatePath(`/team/${id}`)
  revalidatePath('/team')
}

export async function updateTaskAction(f: FormData) {
  const id = n(f, 'task_id')!
  const patch: Parameters<typeof updateTask>[3] = {}
  const status = s(f, 'status')
  if (status) patch.status = status as 'queued'
  if (f.has('assigned_to')) patch.assigned_to = s(f, 'assigned_to') || null
  await updateTask(db(), ME, id, patch)
  kickDelivery(db())
  revalidatePath(`/team/${id}`)
  revalidatePath('/team')
}

export async function claimMyselfAction(f: FormData) {
  const id = n(f, 'task_id')!
  await claimTask(db(), ME, { task_id: id, lease_seconds: 3600 })
  revalidatePath(`/team/${id}`)
}

export async function decideApprovalAction(f: FormData) {
  const id = n(f, 'approval_id')!
  const decision = s(f, 'decision') === 'approved' ? 'approved' : 'rejected'
  await decideApproval(db(), ME, id, decision, s(f, 'note') || undefined)
  kickDelivery(db())
  revalidatePath('/activity')
  revalidatePath('/team')
}

export async function releaseLockAction(f: FormData) {
  await releaseLock(db(), ME, { resource: s(f, 'resource'), force: true })
  revalidatePath('/activity')
}

export async function memoryPutAction(f: FormData) {
  const scope = s(f, 'scope')
  await memoryPut(db(), ME, { scope, key: s(f, 'key'), notes: s(f, 'notes'), source: s(f, 'source') || 'edited by Yaakov in the dashboard' })
  revalidatePath(`/agents/${scope}`)
}

export async function memoryDeleteAction(f: FormData) {
  const scope = s(f, 'scope')
  await memoryDelete(db(), ME, { scope, key: s(f, 'key') })
  revalidatePath(`/agents/${scope}`)
}

export async function markReadAction() {
  await markRead(db(), ME)
  revalidatePath('/agents/owner')
  revalidatePath('/team')
}

/** Yaakov writes to an agent (or a person) directly; it goes out on their channels at once. */
export async function sendMessageAction(f: FormData) {
  const to = s(f, 'to')
  const taskId = n(f, 'task_id')
  await sendMessage(db(), ME, { to, body: s(f, 'body'), task_id: taskId })
  kickDelivery(db())
  if (taskId) revalidatePath(`/team/${taskId}`)
  revalidatePath(`/agents/${to}`)
}
