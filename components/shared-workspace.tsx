'use client'

import Link from 'next/link'
import { useState, type FormEvent, type ReactNode } from 'react'
import { COPY } from '@/lib/copy'
import { JAR_MARK } from '@/lib/collaboration'

/**
 * Words for this section live in COPY.workspace. This file renders them.
 * It does not invent an owner, an actor, or a count.
 *
 * No emoji. The jar is a line drawing on the boundary badge. The badge
 * shows the recorded grant; it does not create one.
 */

const FAIL_CLOSED_OWNER = 'unset@invalid.local'

const BOUNDARY_RULES = [
  COPY.workspace.localContext,
  COPY.workspace.everyApproval,
  COPY.workspace.everyRevision,
  COPY.workspace.agentsAuthenticate,
] as const

export type WorkspaceRevision = {
  id: string
  actor: string | null
  kind: string | null
  message: string | null
  at: string | null
}

export type WorkspaceApprovalStatus = 'approved' | 'changes_requested' | 'dismissed'

export type WorkspaceApproval = {
  id: string
  status: WorkspaceApprovalStatus
  actor: string | null
  owner: string | null
  at?: string | null
  reason?: string | null
}

export type WorkspaceComment = {
  id: string
  actor: string | null
  rowName: string | null
  body: string | null
  parentId?: string | null
}

export type WorkspaceRow = {
  id: string
  label: string
  text: string
}

export type SharedWorkspaceProps = {
  /** Recorded owner email. The fail-closed placeholder is treated as missing. */
  ownerEmail: string | null
  /** Recorded last actor. Omitted from the screen when null. */
  lastActor: string | null
  /**
   * True only when a share grant exists. The page passes false: no grant
   * has been added, and a "shared" badge without one would be decorative.
   */
  shared: boolean
  /** null = the list did not load. [] = loaded, and nothing is there yet. */
  revisions: readonly WorkspaceRevision[] | null
  approvals: readonly WorkspaceApproval[] | null
  comments: readonly WorkspaceComment[] | null
  /** False on first run, when nothing has been submitted for approval. */
  approvalNeeded: boolean
  /** Recorded time of the last change. Omitted when the source did not say. */
  lastChangeAt?: string | null
  /**
   * Who is looking, and whether they may decide. Buttons stay disabled
   * unless this actor is authorized and is not the writer. Omitted means
   * not authorized — never a stand-in profile.
   */
  decisionActor?: string | null
  decisionAuthorized?: boolean
  writer?: string | null
  now?: () => string
  rows?: readonly WorkspaceRow[]
  onComment?: (input: { rowName: string; body: string; parentId: string | null }) => void
  onRestore?: (revisionId: string) => void
  onSave?: () => void
  onPin?: () => void
  onApprove?: () => void
  onRequestChanges?: () => void
  onDismiss?: (reason: string) => void
}

function recordedOwner(email: string | null): string | null {
  if (!email || email === FAIL_CLOSED_OWNER) return null
  return email
}

function recordedActor(actor: string | null): string | null {
  if (!actor) return null
  return actor
}

function Card({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <section
      data-testid={testId}
      className="rounded-card border border-line bg-surface px-5 py-4"
    >
      {children}
    </section>
  )
}

function Label({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted">
      {children}
    </h2>
  )
}

function EmptyOrError({
  rows,
  empty,
  testId,
}: {
  rows: readonly unknown[] | null
  empty: string
  testId: string
}) {
  if (rows === null) {
    return (
      <p data-testid={testId} data-unavailable="true" className="mt-2 text-[13px] text-ink-faint">
        {COPY.error}
      </p>
    )
  }
  if (rows.length === 0) {
    return (
      <p data-testid={testId} className="mt-2 text-[13px] text-ink-faint">
        {empty}
      </p>
    )
  }
  return null
}

function ActionButton({
  children,
  onClick,
  disabled,
  testId,
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
  testId?: string
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="rounded border border-line px-2.5 py-1 text-[13px] text-ink"
    >
      {children}
    </button>
  )
}

function approvalText(approval: WorkspaceApproval): string {
  const actor = recordedActor(approval.actor)
  if (approval.status === 'approved') {
    return actor ? COPY.workspace.approvedByActor(actor) : COPY.workspace.authorNotRecorded
  }
  if (approval.status === 'changes_requested') {
    return approval.owner
      ? COPY.workspace.requestChangesTo(approval.owner)
      : COPY.workspace.ownerNotRecorded
  }
  return actor ? COPY.workspace.dismissedBy(actor) : COPY.workspace.authorNotRecorded
}

function CommentThread({
  comments,
  parentId,
}: {
  comments: readonly WorkspaceComment[]
  parentId: string | null
}) {
  const items = comments.filter((comment) => (comment.parentId ?? null) === parentId)
  if (items.length === 0) return null
  return (
    <ul className="mt-3 flex flex-col" data-testid={parentId === null ? 'feedback-thread' : undefined}>
      {items.map((comment) => (
        <li
          key={comment.id}
          data-testid="comment"
          data-author={comment.actor ?? ''}
          data-readonly="true"
          data-kind="comment"
          className="border-t border-line-soft py-2"
        >
          {comment.rowName ? (
            <p className="text-[13px] text-ink">{COPY.workspace.commentOn(comment.rowName)}</p>
          ) : null}
          <p data-testid="comment-author" className="text-[12px] text-ink-muted">
            {recordedActor(comment.actor) ?? COPY.workspace.authorNotRecorded}
          </p>
          {comment.body ? <p className="text-[13px] text-ink-muted">{comment.body}</p> : null}
          <CommentThread comments={comments} parentId={comment.id} />
        </li>
      ))}
    </ul>
  )
}

export function SharedWorkspace({
  ownerEmail,
  lastActor,
  shared,
  revisions,
  approvals,
  comments,
  approvalNeeded,
  lastChangeAt = null,
  decisionActor = null,
  decisionAuthorized = false,
  writer = null,
  now,
  rows,
  onComment,
  onRestore,
  onSave,
  onPin,
  onApprove,
  onRequestChanges,
  onDismiss,
}: SharedWorkspaceProps) {
  const owner = recordedOwner(ownerEmail)
  const actor = recordedActor(lastActor)
  const boundary = shared ? COPY.workspace.sharedWithAgents : COPY.workspace.localContext
  const [decisions, setDecisions] = useState<WorkspaceApproval[]>([])
  const [localComments, setLocalComments] = useState<WorkspaceComment[]>([])
  const shownApprovals = approvals === null ? null : [...approvals, ...decisions]
  const shownComments = comments === null ? null : [...comments, ...localComments]

  function stamp(): string {
    return now ? now() : new Date().toISOString()
  }

  function canAct(): boolean {
    if (!decisionAuthorized) return false
    const who = recordedActor(decisionActor)
    if (!who) return false
    if (writer && who === writer) return false
    return true
  }

  function approve() {
    if (!canAct() || !onApprove) return
    const at = stamp()
    const who = recordedActor(decisionActor)
    setDecisions((prev) => [
      ...prev,
      { id: `approve:${at}`, status: 'approved', actor: who, owner, at },
    ])
    onApprove()
  }

  function requestChanges() {
    if (!canAct() || !onRequestChanges || !owner) return
    const at = stamp()
    const who = recordedActor(decisionActor)
    setDecisions((prev) => [
      ...prev,
      { id: `changes:${at}`, status: 'changes_requested', actor: who, owner, at },
    ])
    onRequestChanges()
  }

  function dismiss(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!canAct() || !onDismiss) return
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim()
    if (!reason) return
    const at = stamp()
    const who = recordedActor(decisionActor)
    setDecisions((prev) => [
      ...prev,
      { id: `dismiss:${at}`, status: 'dismissed', actor: who, owner, at, reason },
    ])
    onDismiss(reason)
  }

  function addComment(event: FormEvent<HTMLFormElement>, rowName: string) {
    event.preventDefault()
    if (!onComment) return
    const who = recordedActor(decisionActor)
    if (!who) return
    const body = String(new FormData(event.currentTarget).get('body') ?? '').trim()
    if (!body) return
    const at = stamp()
    setLocalComments((prev) => [
      ...prev,
      { id: `comment:${at}`, actor: who, rowName, body, parentId: null },
    ])
    onComment({ rowName, body, parentId: null })
    event.currentTarget.reset()
  }

  return (
    <main className="mx-auto w-full max-w-shell px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h1 className="text-[15px] font-medium tracking-[-0.01em] text-ink">
          {COPY.workspace.title}
        </h1>
        <Link href="/" className="text-[12px] text-ink-muted underline-offset-4 hover:underline">
          {COPY.workspace.back}
        </Link>
      </header>

      <div className="flex flex-col gap-4">
        <Card testId="workspace-intro">
          <dl className="flex flex-col gap-3">
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted">
                {COPY.workspace.whatItIs}
              </dt>
              <dd className="mt-0.5 text-[13px] text-ink">{COPY.workspace.whatItIsBody}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted">
                {COPY.workspace.whoIsInIt}
              </dt>
              <dd className="mt-0.5 text-[13px] text-ink">{COPY.workspace.whoBody}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted">
                {COPY.workspace.whatItCosts}
              </dt>
              <dd className="mt-0.5 text-[13px] text-ink">{COPY.workspace.costBody}</dd>
            </div>
          </dl>
          <p
            data-testid="workspace-boundary-badge"
            data-boundary={shared ? 'shared' : 'local'}
            className="mt-4 inline-flex items-center gap-2 rounded-card border border-line px-2 py-1 text-[11px] text-ink-muted"
          >
            <span data-testid="jar-icon" dangerouslySetInnerHTML={{ __html: JAR_MARK }} />
            {boundary}
          </p>
        </Card>

        <Card testId="workspace-history">
          <Label>{COPY.workspace.changeHistory}</Label>
          <p className="mt-1 text-[13px] text-ink-muted">{COPY.workspace.revisionsStayLocal}</p>
          <EmptyOrError
            rows={revisions}
            empty={COPY.workspace.noRevisions}
            testId="workspace-revisions-state"
          />
          {revisions && revisions.length > 0 ? (
            <ul className="mt-3 flex flex-col">
              {revisions.map((revision) => {
                const savedBy = recordedActor(revision.actor)
                return (
                  <li key={revision.id} data-readonly="false" data-kind="write" className="border-t border-line-soft py-2">
                    <p className="text-[13px] text-ink">
                      {savedBy ? COPY.workspace.savedBy(savedBy) : COPY.workspace.authorNotRecorded}
                    </p>
                    {revision.kind ? (
                      <p className="text-[12px] text-ink-muted">
                        {COPY.workspace.changeKind}: {revision.kind}
                      </p>
                    ) : null}
                    {revision.message ? (
                      <p className="text-[13px] text-ink-muted">
                        {COPY.workspace.changeMessage}: {revision.message}
                      </p>
                    ) : null}
                    {revision.at ? (
                      <p className="font-numeric text-[11px] text-ink-faint">
                        {COPY.workspace.changeWhen}: {revision.at}
                      </p>
                    ) : null}
                    {onRestore ? (
                      <div className="mt-2">
                        <ActionButton onClick={() => onRestore(revision.id)}>
                          {COPY.workspace.restoreThisVersion}
                        </ActionButton>
                        <p className="mt-1 text-[12px] text-ink-faint">{COPY.workspace.restoreNote}</p>
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          ) : null}
          {onSave || onPin ? (
            <div className="mt-3 flex flex-col gap-2">
              {onSave ? (
                <div>
                  <ActionButton onClick={onSave}>{COPY.workspace.save}</ActionButton>
                  <p className="mt-1 text-[12px] text-ink-faint">{COPY.workspace.saveNote}</p>
                </div>
              ) : null}
              {onPin ? (
                <div>
                  <ActionButton onClick={onPin}>{COPY.workspace.pinThisVersion}</ActionButton>
                  <p className="mt-1 text-[12px] text-ink-faint">{COPY.workspace.pinNote}</p>
                </div>
              ) : null}
            </div>
          ) : null}
        </Card>

        <Card testId="workspace-approvals">
          <Label>{COPY.workspace.approvals}</Label>
          <div data-testid="ownership-panel">
            <p data-testid="workspace-owner" className="mt-2 text-[13px] text-ink">
              {owner ? COPY.workspace.owner(owner) : COPY.workspace.ownerNotRecorded}
            </p>
            {actor ? (
              <p data-testid="artifact-last-actor" className="mt-1 text-[13px] text-ink-muted">
                {COPY.workspace.lastChangedBy(actor)}
              </p>
            ) : null}
            {lastChangeAt ? (
              <p data-testid="artifact-last-change" className="mt-1 font-numeric text-[13px] tabular-nums text-ink">
                {COPY.workspace.changeWhen}: {lastChangeAt}
              </p>
            ) : null}
          </div>
          {shownApprovals === null ? (
            <p data-testid="workspace-approvals-state" data-unavailable="true" className="mt-2 text-[13px] text-ink-faint">
              {COPY.error}
            </p>
          ) : null}
          {shownApprovals && shownApprovals.length === 0 ? (
            <div data-testid="workspace-approvals-state" className="mt-2">
              <p className="text-[13px] text-ink-faint">{COPY.workspace.noApprovals}</p>
              {approvalNeeded ? null : (
                <p className="mt-1 text-[13px] text-ink-faint">{COPY.workspace.noApprovalNeeded}</p>
              )}
            </div>
          ) : null}
          {shownApprovals && shownApprovals.length > 0 ? (
            <ul className="mt-3 flex flex-col">
              {shownApprovals.map((approval) => (
                <li
                  key={approval.id}
                  data-testid={approval.at ? 'audit-entry' : undefined}
                  data-kind={approval.status}
                  data-author={approval.actor ?? ''}
                  className="border-t border-line-soft py-2 text-[13px] text-ink"
                >
                  <p>{approvalText(approval)}</p>
                  {approval.at ? (
                    <p className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-ink-faint">
                      <span data-testid="audit-author">
                        {recordedActor(approval.actor) ?? COPY.workspace.authorNotRecorded}
                      </span>
                      <time data-testid="audit-at" className="font-numeric tabular-nums" dateTime={approval.at}>
                        {approval.at}
                      </time>
                      <span data-testid="audit-status">{approval.status}</span>
                    </p>
                  ) : null}
                  {approval.reason ? <p>{approval.reason}</p> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {onApprove || (onRequestChanges && owner) || onDismiss ? (
            <div data-testid="approval-controls" className="mt-3 flex flex-col gap-2">
              {onApprove ? (
                <ActionButton testId="approve" disabled={!canAct()} onClick={approve}>
                  {COPY.workspace.approve}
                </ActionButton>
              ) : null}
              {onRequestChanges && owner ? (
                <ActionButton testId="request-changes" disabled={!canAct()} onClick={requestChanges}>
                  {COPY.workspace.requestChangesTo(owner)}
                </ActionButton>
              ) : null}
              {onDismiss ? (
                <form onSubmit={dismiss} className="flex flex-col gap-2">
                  <label className="text-[12px] text-ink-muted">
                    {COPY.workspace.reason}
                    <input
                      name="reason"
                      data-testid="dismiss-reason"
                      className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-[13px] text-ink outline-none focus:border-ink-muted"
                    />
                  </label>
                  <p className="text-[12px] text-ink-faint">{COPY.workspace.dismissNote}</p>
                  <button
                    type="submit"
                    data-testid="dismiss"
                    disabled={!canAct()}
                    className="w-fit rounded border border-line px-2.5 py-1 text-[13px] text-ink"
                  >
                    {COPY.workspace.dismiss}
                  </button>
                </form>
              ) : null}
            </div>
          ) : null}
        </Card>

        <Card testId="workspace-comments">
          <Label>{COPY.workspace.comments}</Label>
          <EmptyOrError
            rows={shownComments}
            empty={COPY.workspace.noComments}
            testId="workspace-comments-state"
          />
          {rows && rows.length > 0 ? (
            <div data-testid="artifact-rows">
              {rows.map((row) => (
                <article key={row.id} data-testid="artifact-row" data-row-id={row.id} className="mt-3">
                  <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted">
                    {row.label}
                  </h3>
                  <p data-testid={`row-text-${row.id}`} className="mt-1 text-[13px] text-ink">
                    {row.text}
                  </p>
                  {onComment ? (
                    <form onSubmit={(event) => addComment(event, row.label)} className="mt-2 flex flex-col gap-2 sm:flex-row">
                      <input
                        name="body"
                        data-testid={`comment-input-${row.id}`}
                        aria-label={COPY.workspace.commentOn(row.label)}
                        className="w-full rounded border border-line bg-white px-3 py-2 text-[13px] text-ink outline-none focus:border-ink-muted"
                      />
                      <button
                        type="submit"
                        data-testid={`comment-submit-${row.id}`}
                        className="w-fit rounded border border-line px-2.5 py-1 text-[13px] text-ink"
                      >
                        {COPY.workspace.commentOn(row.label)}
                      </button>
                    </form>
                  ) : null}
                </article>
              ))}
            </div>
          ) : null}
          {shownComments && shownComments.length > 0 ? (
            <CommentThread comments={shownComments} parentId={null} />
          ) : null}
        </Card>

        <Card testId="workspace-boundary">
          <h2 className="text-[13px] font-medium text-ink">{COPY.workspace.boundaryTitle}</h2>
          <ul className="mt-2 flex flex-col gap-1">
            {BOUNDARY_RULES.map((rule) => (
              <li key={rule} className="text-[13px] text-ink-muted">
                {rule}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </main>
  )
}
