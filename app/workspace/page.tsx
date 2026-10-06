'use client'

import { useCallback, useEffect, useState } from 'react'
import { useApi } from '@/components/use-api'
import {
  SharedWorkspace,
  type WorkspaceApproval,
  type WorkspaceComment,
  type WorkspaceRevision,
} from '@/components/shared-workspace'

/**
 * Workspace page, wired live. Revisions come from the same stored rows the
 * artifact panels read — never a fixture. null = the load failed (the
 * component says so); [] = loaded, and nothing is there yet.
 *
 * Approvals and comments are per-artifact; until a list endpoint exists the
 * workspace shows the honest loaded-empty state for those two lists — not
 * a fixture, not a failed fetch rewritten as empty.
 *
 * Owner comes from the allow-list env when it is a real address. The
 * fail-closed placeholder is not a person, so it is not shown.
 * shared stays false until a grant exists. Flipping the badge without one
 * would claim a share that was never recorded.
 */
function ownerFromEnv(): string | null {
  const email = process.env.ALLOWED_USER_EMAIL
  if (!email || email === 'unset@invalid.local') return null
  return email
}

type Row = {
  id: string
  title?: string | null
  name?: string | null
  change_kind?: string | null
  change_message?: string | null
  actor?: string | null
  updated_at?: string | null
  created_at?: string | null
}

function toRevisions(rows: Row[]): WorkspaceRevision[] {
  return rows.map((r) => ({
    id: String(r.id),
    actor: r.actor ?? null,
    kind: r.change_kind ?? null,
    message: r.change_message ?? r.title ?? r.name ?? null,
    at: r.updated_at ?? r.created_at ?? null,
  }))
}

export default function WorkspacePage() {
  const api = useApi()
  const [revisions, setRevisions] = useState<WorkspaceRevision[] | null>([])

  const load = useCallback(async () => {
    try {
      const [ideas, costs] = await Promise.all([
        api('/api/ideas'),
        api('/api/costs'),
      ])
      const rows: Row[] = [
        ...((ideas as { ideas?: Row[] }).ideas ?? []),
        ...((costs as { costs?: Row[] }).costs ?? []),
      ]
      setRevisions(toRevisions(rows))
    } catch {
      setRevisions(null)
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  const emptyApprovals: WorkspaceApproval[] = []
  const emptyComments: WorkspaceComment[] = []

  return (
    <SharedWorkspace
      ownerEmail={ownerFromEnv()}
      lastActor={null}
      shared={false}
      revisions={revisions}
      approvals={revisions === null ? null : emptyApprovals}
      comments={revisions === null ? null : emptyComments}
      approvalNeeded={false}
    />
  )
}
