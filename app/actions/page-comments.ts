'use server'

/**
 * The comment layer's door to the database ("comment on this", migration 0015). Runs as the
 * signed-in human ('owner'); the login gate in middleware.ts protects every server action.
 * Every action answers {ok, ...} instead of throwing, so the browser can keep its own copy of a
 * draft and say "saved on this device" when the server is unreachable.
 */
import { getDb } from '@/lib/db'
import { kickDelivery } from '@/lib/notify/kick'
import { OpsError } from '@/lib/ops/core'
import {
  commentRecipients, discardDraft, listMyPageComments, replyToPageComment, saveDraft, sendPageComments, setPageCommentResolved,
  type DraftInput, type PageCommentView, type SendResult,
} from '@/lib/page-comments/core'

const ME = 'owner'

type Fail = { ok: false; error: string }
const NOT_CONNECTED: Fail = { ok: false, error: 'The database is not connected, so this is saved on this device only.' }

function fail(e: unknown): Fail {
  if (e instanceof OpsError) return { ok: false, error: e.message }
  console.error('page comment action failed', (e as Error).message)
  return { ok: false, error: 'The server could not save that right now. It is kept on this device.' }
}

export async function listMyCommentsAction(): Promise<{ ok: true; comments: PageCommentView[]; recipients: { id: string; display_name: string }[] } | Fail> {
  const db = getDb()
  if (!db) return NOT_CONNECTED
  try {
    const [comments, recipients] = await Promise.all([listMyPageComments(db, ME, { include_resolved: true }), commentRecipients(db)])
    return { ok: true, comments, recipients }
  } catch (e) {
    return fail(e)
  }
}

export async function saveCommentDraftAction(input: DraftInput): Promise<{ ok: true; comment: PageCommentView } | Fail> {
  const db = getDb()
  if (!db) return NOT_CONNECTED
  try {
    return { ok: true, comment: await saveDraft(db, ME, input) }
  } catch (e) {
    return fail(e)
  }
}

export async function discardCommentDraftAction(clientId: string): Promise<{ ok: true; discarded: boolean } | Fail> {
  const db = getDb()
  if (!db) return NOT_CONNECTED
  try {
    return { ok: true, ...(await discardDraft(db, ME, clientId)) }
  } catch (e) {
    return fail(e)
  }
}

export async function sendCommentsAction(clientIds: string[]): Promise<{ ok: true; results: SendResult[] } | Fail> {
  const db = getDb()
  if (!db) return { ok: false, error: 'The database is not connected, so nothing can be sent yet. Your drafts are kept.' }
  try {
    const results = await sendPageComments(db, ME, Array.isArray(clientIds) ? clientIds : [])
    // The agent hears about it now (email / webhook / ping), not when it next checks in.
    kickDelivery(db)
    return { ok: true, results }
  } catch (e) {
    return fail(e)
  }
}

export async function replyCommentAction(id: number, body: string): Promise<{ ok: true } | Fail> {
  const db = getDb()
  if (!db) return NOT_CONNECTED
  try {
    await replyToPageComment(db, ME, Number(id), body)
    kickDelivery(db)
    return { ok: true }
  } catch (e) {
    return fail(e)
  }
}

export async function resolveCommentAction(id: number, resolved: boolean): Promise<{ ok: true; comment: PageCommentView } | Fail> {
  const db = getDb()
  if (!db) return NOT_CONNECTED
  try {
    return { ok: true, comment: await setPageCommentResolved(db, ME, Number(id), Boolean(resolved)) }
  } catch (e) {
    return fail(e)
  }
}
