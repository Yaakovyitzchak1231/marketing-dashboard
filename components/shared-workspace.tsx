'use client'

import Link from 'next/link'
import { type FormEvent, type ReactNode } from 'react'
import { COPY } from '@/lib/copy'

/**
 * Words for this section live in COPY.workspace. This file renders them.
 * It does not invent an owner, an actor, or a count.
 *
 * No icon. An emoji would be decoration. A graphic, if one is added later,
 * belongs to the UI card and must not be an emoji.
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
}

export type WorkspaceComment = {
  id: string
  actor: string | null
  rowName: string | null
  body: string | null
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
}: {
  children: ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
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

export function SharedWorkspace({
  ownerEmail,
  lastActor,
  shared,
  revisions,
  approvals,
  comments,
  approvalNeeded,
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

  function dismiss(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!onDismiss) return
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '')
    onDismiss(reason)
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
            className="mt-4 inline-block rounded-card border border-line px-2 py-1 text-[11px] text-ink-muted"
          >
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
                  <li key={revision.id} className="border-t border-line-soft py-2">
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
          <p data-testid="workspace-owner" className="mt-2 text-[13px] text-ink">
            {owner ? COPY.workspace.owner(owner) : COPY.workspace.ownerNotRecorded}
          </p>
          {actor ? (
            <p className="mt-1 text-[13px] text-ink-muted">{COPY.workspace.lastChangedBy(actor)}</p>
          ) : null}
          {approvals === null ? (
            <p data-testid="workspace-approvals-state" data-unavailable="true" className="mt-2 text-[13px] text-ink-faint">
              {COPY.error}
            </p>
          ) : null}
          {approvals && approvals.length === 0 ? (
            <div data-testid="workspace-approvals-state" className="mt-2">
              <p className="text-[13px] text-ink-faint">{COPY.workspace.noApprovals}</p>
              {approvalNeeded ? null : (
                <p className="mt-1 text-[13px] text-ink-faint">{COPY.workspace.noApprovalNeeded}</p>
              )}
            </div>
          ) : null}
          {approvals && approvals.length > 0 ? (
            <ul className="mt-3 flex flex-col">
              {approvals.map((approval) => (
                <li key={approval.id} className="border-t border-line-soft py-2 text-[13px] text-ink">
                  {approvalText(approval)}
                </li>
              ))}
            </ul>
          ) : null}
          {onApprove || (onRequestChanges && owner) || onDismiss ? (
            <div className="mt-3 flex flex-col gap-2">
              {onApprove ? (
                <ActionButton onClick={onApprove}>{COPY.workspace.approve}</ActionButton>
              ) : null}
              {onRequestChanges && owner ? (
                <ActionButton onClick={onRequestChanges}>
                  {COPY.workspace.requestChangesTo(owner)}
                </ActionButton>
              ) : null}
              {onDismiss ? (
                <form onSubmit={dismiss} className="flex flex-col gap-2">
                  <label className="text-[12px] text-ink-muted">
                    {COPY.workspace.reason}
                    <input
                      name="reason"
                      className="mt-1 block w-full rounded border border-line bg-white px-3 py-2 text-[13px] text-ink outline-none focus:border-ink-muted"
                    />
                  </label>
                  <p className="text-[12px] text-ink-faint">{COPY.workspace.dismissNote}</p>
                  <button
                    type="submit"
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
            rows={comments}
            empty={COPY.workspace.noComments}
            testId="workspace-comments-state"
          />
          {comments && comments.length > 0 ? (
            <ul className="mt-3 flex flex-col">
              {comments.map((comment) => (
                <li key={comment.id} className="border-t border-line-soft py-2">
                  {comment.rowName ? (
                    <p className="text-[13px] text-ink">{COPY.workspace.commentOn(comment.rowName)}</p>
                  ) : null}
                  <p className="text-[12px] text-ink-muted">
                    {recordedActor(comment.actor) ?? COPY.workspace.authorNotRecorded}
                  </p>
                  {comment.body ? (
                    <p className="text-[13px] text-ink-muted">{comment.body}</p>
                  ) : null}
                </li>
              ))}
            </ul>
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
