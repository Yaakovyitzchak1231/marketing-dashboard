'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useApi } from '@/components/use-api'
import { COPY } from '@/lib/copy'

type Revision = {
  id: string
  revision_number: number
  actor: string | null
  change_kind: string | null
  change_message: string | null
  created_at: string
}

type Approval = {
  id: string
  actor: string | null
  status: string | null
  owner: string | null
  reason: string | null
  created_at: string
}

type Comment = {
  id: string
  row_name: string
  text: string
  author: string | null
  created_at: string
}

type ArtifactProvenanceProps = {
  ownerEmail?: string | null
  revisionsUrl: string
  approvalsUrl: string
  commentsUrl: string
  artifactType: string
  artifactId: string
  rowName?: string
}

function actorOrDefault(actor: string | null): string {
  return actor ?? COPY.workspace.authorNotRecorded
}

function formatIso(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString()
}

export function ArtifactProvenance({
  ownerEmail,
  revisionsUrl,
  approvalsUrl,
  commentsUrl,
  artifactType,
  artifactId,
  rowName,
}: ArtifactProvenanceProps) {
  const [revisions, setRevisions] = useState<Revision[]>([])
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [comments, setComments] = useState<Comment[]>([])
  const [commentText, setCommentText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const params = useSearchParams()
  const api = useApi()

  const owner = ownerEmail ?? COPY.workspace.ownerNotRecorded

  // Fail-closed allow-list. The approval surface is enabled only for the
  // literal allowed viewer email. The email arrives as the ownerEmail prop —
  // never derived from a stored row — so no other audience is ever implied.
  // Default (no owner email) denies everyone: the controls render disabled.
  // Server-side, the API routes enforce the same ALLOWED_USER_EMAIL gate
  // (default 'unset@invalid.local') against the signed-in session.
  const ALLOWED_VIEWER = 'yaakovytroutai@gmail.com'
  const authorized =
    !!ownerEmail && ownerEmail.toLowerCase() === ALLOWED_VIEWER.toLowerCase()

  const load = useCallback(async () => {
    setError(null)
    // No artifact selected (list pages pass artifactId=""): show the empty
    // states without firing requests the routes would reject.
    if (!artifactId) {
      setRevisions([])
      setApprovals([])
      setComments([])
      return
    }
    const qs = `?artifact_type=${encodeURIComponent(artifactType)}&artifact_id=${encodeURIComponent(artifactId)}`
    try {
      const [r, a, c] = await Promise.all([
        api(`${revisionsUrl}${qs}`),
        api(`${approvalsUrl}${qs}`),
        api(`${commentsUrl}${qs}`),
      ])
      setRevisions(Array.isArray(r) ? (r as Revision[]) : [])
      setApprovals(Array.isArray(a) ? (a as Approval[]) : [])
      setComments(Array.isArray(c) ? (c as Comment[]) : [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    }
  }, [api, revisionsUrl, approvalsUrl, commentsUrl, artifactType, artifactId])

  useEffect(() => {
    void load()
  }, [load])

  const submitComment = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!commentText.trim()) return
    try {
      await api(commentsUrl, {
        method: 'POST',
        body: JSON.stringify({
          artifact_type: artifactType,
          artifact_id: artifactId,
          row_name: rowName ?? '',
          text: commentText.trim(),
        }),
      })
      setCommentText('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add comment')
    }
  }

  const approve = async () => {
    setError(null)
    try {
      await api(approvalsUrl, {
        method: 'POST',
        body: JSON.stringify({
          artifact_type: artifactType,
          artifact_id: artifactId,
          status: 'approved',
          owner: ownerEmail ?? '',
          reason: null,
        }),
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve')
    }
  }

  const requestChanges = async (ownerFor: string) => {
    setError(null)
    try {
      await api(approvalsUrl, {
        method: 'POST',
        body: JSON.stringify({
          artifact_type: artifactType,
          artifact_id: artifactId,
          status: 'requested',
          owner: ownerFor,
          reason: null,
        }),
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to request changes')
    }
  }

  const dismissApproval = async (reason?: string) => {
    setError(null)
    try {
      await api(approvalsUrl, {
        method: 'POST',
        body: JSON.stringify({
          artifact_type: artifactType,
          artifact_id: artifactId,
          status: 'dismissed',
          owner: ownerEmail ?? '',
          reason: reason ?? null,
        }),
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to dismiss')
    }
  }

  const restoreRevision = async (revisionNumber: number) => {
    setError(null)
    try {
      await api('/api/checkpoints/restore', {
        method: 'POST',
        body: JSON.stringify({
          artifact_type: artifactType,
          artifact_id: artifactId,
          revision_number: revisionNumber,
        }),
      })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to restore')
    }
  }

  const approvalKind = approvals.length === 0 ? null : approvals[0]?.status ?? null

  return (
    <section
      className="rounded-card border border-line bg-surface px-5 py-4 space-y-5"
      data-testid="artifact-provenance"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium text-ink">{COPY.workspace.title}</h2>
          <p className="mt-1 text-xs text-ink-faint">
            {COPY.workspace.whatItIsBody}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-md border border-line/70 bg-white/50 px-2.5 py-1.5 text-[11px] text-ink-faint">
          <span>{COPY.workspace.boundaryTitle}</span>
          <span className="px-1.5">·</span>
          <span>{COPY.workspace.everyRevision}</span>
          {ownerEmail ? (
            <>
              <span className="px-1.5">·</span>
              <span>{COPY.workspace.agentsAuthenticate}</span>
            </>
          ) : null}
        </div>
      </div>

      {/* Boundary badge — "Local context can stay local" vs "Shared with
          agents". Truthful: we only claim a share with agents when one is
          actually recorded (approved). Nothing here does. */}
      <div
        data-testid="boundary-badge"
        className="mt-3 flex items-center gap-2 rounded-md border border-line/70 bg-white/60 px-3 py-2 text-[11px] text-ink-muted"
      >
        <span className="flex items-center gap-2">
          <span className="font-medium uppercase tracking-[0.06em]">
            {COPY.workspace.boundaryTitle}
          </span>
        </span>
        <span className="px-1.5">·</span>
        <span className="font-medium">
          {COPY.workspace.localContext}
        </span>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line/60 pt-3 text-xs text-ink-faint">
        <span className="font-medium text-ink-muted">{COPY.workspace.owner(owner)}</span>
        <Link
          href={params.get('path') === '/workspace' ? '/workspace' : '/'}
          className="hover:underline underline-offset-2"
        >
          {COPY.workspace.back}
        </Link>
      </div>

      {/* Revision history */}
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h3 className="text-xs font-medium uppercase tracking-[0.08em] text-ink-muted">
            {COPY.workspace.changeHistory}
          </h3>
          {revisions.length > 0 && (
            <button
              type="button"
              className="text-[11px] text-ink-muted underline underline-offset-2 hover:text-ink"
              onClick={() => setRevisions([])}
            >
              {COPY.workspace.restoreThisVersion}
            </button>
          )}
        </div>

        {error && revisions.length > 0 ? (
          <p className="mt-1 text-xs text-ink-muted">{error}</p>
        ) : revisions.length === 0 ? (
          <p className="mt-1 text-xs text-ink-faint">{COPY.workspace.noRevisions}</p>
        ) : (
          <div className="mt-2 overflow-x-auto rounded-md border border-line bg-white/50">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line text-[11px] uppercase tracking-[0.06em] text-ink-muted">
                  <th className="px-3 py-2 text-left">#{' '}
                    {COPY.workspace.changeHistory}</th>
                  <th className="px-3 py-2 text-left">{COPY.workspace.changeKind}</th>
                  <th className="px-3 py-2 text-left">{COPY.workspace.changeMessage}</th>
                  <th className="px-3 py-2 text-left">{COPY.workspace.changeWhen}</th>
                </tr>
              </thead>
              <tbody>
                {[...revisions]
                  .sort((a, b) => a.revision_number - b.revision_number)
                  .map((r) => (
                    <tr key={r.id} className="border-b border-line/60 last:border-0">
                      <td className="px-3 py-2 tabular-nums text-ink">{r.revision_number}</td>
                      <td className="px-3 py-2 text-ink">{actorOrDefault(r.actor)}</td>
                      <td className="px-3 py-2 text-ink">{r.change_kind ?? ''}</td>
                      <td className="px-3 py-2 text-ink">{r.change_message ?? ''}</td>
                      <td className="px-3 py-2 text-[11px] text-ink-faint">
                        {formatIso(r.created_at)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}

        {revisions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {revisions.map((r) => (
              <button
                key={r.id}
                type="button"
                className="rounded border border-line bg-white/60 px-2.5 py-1 text-[11px] text-ink"
                onClick={() => restoreRevision(r.revision_number)}
              >
                {COPY.workspace.restoreThisVersion} #{r.revision_number}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Approvals */}
      <div className="border-t border-line/60 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-xs font-medium uppercase tracking-[0.08em] text-ink-muted">
            {COPY.workspace.approvals}
          </h3>
          <span className="text-[11px] text-ink-faint">
            {COPY.workspace.everyApproval}
          </span>
        </div>

        {approvals.length === 0 ? (
          <p className="mt-1 text-xs text-ink-faint">
            {approvalKind === null ? COPY.workspace.noApprovals : COPY.workspace.noApprovalNeeded}
          </p>
        ) : (
          <ul className="mt-2 space-y-2 text-xs">
            {approvals.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-line/60 px-2.5 py-1.5"
              >
                <div>
                  <p className="text-[11px] text-ink">
                    {a.status === 'approved'
                      ? COPY.workspace.approvedByActor(a.actor ?? COPY.workspace.authorNotRecorded)
                      : a.status === 'requested'
                        ? COPY.workspace.requestChangesTo(a.owner ?? COPY.workspace.ownerNotRecorded)
                        : a.status === 'dismissed'
                          ? COPY.workspace.dismissedBy(a.actor ?? COPY.workspace.authorNotRecorded)
                          : a.status}
                  </p>
                  {a.reason ? (
                    <p className="mt-0.5 text-[11px] text-ink-faint">{a.reason}</p>
                  ) : null}
                </div>
                <span className="text-[11px] text-ink-faint">
                  {formatIso(a.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded border border-line bg-white/60 px-2.5 py-1 text-[11px] text-ink disabled:opacity-40"
            onClick={() => approve()}
            disabled={!authorized}
          >
            {COPY.workspace.approve}
          </button>
          <button
            type="button"
            className="rounded border border-line bg-white/60 px-2.5 py-1 text-[11px] text-ink disabled:opacity-40"
            onClick={() => requestChanges(owner)}
            disabled={!authorized}
          >
            {COPY.workspace.requestChangesTo(owner)}
          </button>
          <button
            type="button"
            className="rounded border border-line bg-white/60 px-2.5 py-1 text-[11px] text-ink disabled:opacity-40"
            onClick={() => dismissApproval()}
            disabled={!authorized}
          >
            {COPY.workspace.dismiss}
          </button>
        </div>
      </div>

      {/* Comments */}
      <div className="border-t border-line/60 pt-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h3 className="text-xs font-medium uppercase tracking-[0.08em] text-ink-muted">
            {COPY.workspace.comments}
          </h3>
          <span className="text-[11px] text-ink-faint">
            {COPY.workspace.noComments}
          </span>
        </div>

        {comments.length === 0 ? (
          <p className="mt-1 text-xs text-ink-faint">{COPY.workspace.noComments}</p>
        ) : (
          <ul className="mt-2 space-y-2 text-xs">
            {comments.map((c) => (
              <li key={c.id} className="rounded-md border border-line/60 px-2.5 py-1.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-[11px] text-ink">
                    {c.author ?? COPY.workspace.authorNotRecorded}
                  </span>
                  <span className="text-[11px] text-ink-faint">
                    {formatIso(c.created_at)}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-ink-faint">{c.text}</p>
              </li>
            ))}
          </ul>
        )}

        {rowName && artifactId ? (
          <form onSubmit={submitComment} className="mt-2 flex flex-wrap gap-2">
            <label className="flex-1 min-w-0 rounded border border-line bg-white/60 px-2.5 py-1.5 text-[11px] text-ink">
              {COPY.workspace.commentOn(rowName)}
              <input
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                placeholder="Say something"
                className="mt-0.5 w-full border-0 focus:ring-1 focus:ring-ink/20 outline-none focus-visible:ring-2 focus-visible:ring-ink-muted"
              />
            </label>
            <button
              type="submit"
              className="shrink-0 rounded bg-ink px-3 py-1.5 text-[11px] text-white disabled:opacity-40"
              disabled={!commentText.trim()}
            >
              {COPY.workspace.save}
            </button>
          </form>
        ) : null}

        {error ? (
          <p className="mt-2 text-xs text-ink-muted">{error}</p>
        ) : null}
      </div>
    </section>
  )
}
