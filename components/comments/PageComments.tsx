'use client'

import { CommentLayer, type CommentActions } from './CommentLayer'
import {
  discardCommentDraftAction, replyCommentAction, resolveCommentAction, saveCommentDraftAction, sendCommentsAction,
} from '@/app/actions/page-comments'
import { useRole, VIEWER_REFUSAL } from '@/components/auth/useRole'
import { usePreferences } from '@/components/shell/preferences'

/**
 * The list is a GET (app/api/page-comments/route.ts), not a server action: server actions are
 * POSTs, and middleware.ts refuses every POST from a viewer, which put a 403 on every page.
 */
export const listMyComments: CommentActions['list'] = async () => {
  try {
    const res = await fetch('/api/page-comments', { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } })
    if (res.status === 403) return { ok: false, error: VIEWER_REFUSAL }
    if (!res.ok) return { ok: false, error: 'Could not reach the server.' }
    return (await res.json()) as Awaited<ReturnType<CommentActions['list']>>
  } catch {
    return { ok: false, error: 'Could not reach the server.' }
  }
}

const ACTIONS: CommentActions = {
  list: listMyComments,
  save: saveCommentDraftAction,
  discard: discardCommentDraftAction,
  send: sendCommentsAction,
  reply: replyCommentAction,
  resolve: resolveCommentAction,
}

/**
 * The comment layer, wired to the server. It is part of Review mode: off by
 * default, turned on from the account menu or the command palette, so pins
 * and the floating comment bar never sit on top of everyday work. Viewers get
 * it read-only.
 */
export function PageComments() {
  const { reviewMode, setReviewMode } = usePreferences()
  if (!reviewMode) return null
  return <PageCommentsLayer onExit={() => setReviewMode(false)} />
}

function PageCommentsLayer({ onExit }: { onExit: () => void }) {
  const role = useRole()
  // Wait for the role (one shared GET) so a viewer's layer never starts a write it can't make.
  if (role === undefined) return null
  return <CommentLayer actions={ACTIONS} readOnly={role === 'viewer'} onExit={onExit} />
}
