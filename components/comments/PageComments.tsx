'use client'

import { CommentLayer, type CommentActions } from './CommentLayer'
import {
  discardCommentDraftAction, listMyCommentsAction, replyCommentAction, resolveCommentAction, saveCommentDraftAction, sendCommentsAction,
} from '@/app/actions/page-comments'

const ACTIONS: CommentActions = {
  list: listMyCommentsAction,
  save: saveCommentDraftAction,
  discard: discardCommentDraftAction,
  send: sendCommentsAction,
  reply: replyCommentAction,
  resolve: resolveCommentAction,
}

/** The comment layer on every page, wired to the server actions. */
export function PageComments() {
  return <CommentLayer actions={ACTIONS} />
}
