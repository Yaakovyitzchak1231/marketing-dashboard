/**
 * Workspace page mapping: stored rows (the shape /api/ideas and /api/costs
 * return) become the revision list. Missing actor/message/at stay null —
 * the source did not say — and the component renders "Author not recorded".
 */
import { describe, expect, it } from 'vitest'

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

function toRevisions(rows: Row[]) {
  return rows.map((r) => ({
    id: String(r.id),
    actor: r.actor ?? null,
    kind: r.change_kind ?? null,
    message: r.change_message ?? r.title ?? r.name ?? null,
    at: r.updated_at ?? r.created_at ?? null,
  }))
}

describe('workspace revision mapping', () => {
  it('maps stored rows, keeping unrecorded fields null', () => {
    const out = toRevisions([
      {
        id: 'a',
        title: 'T',
        change_kind: 'edit',
        change_message: 'm',
        actor: 'yaakovytroutai@gmail.com',
        updated_at: '2026-10-06T00:00:00Z',
        created_at: '2026-10-05T00:00:00Z',
      },
      { id: 'b', title: 'U', created_at: '2026-10-05T00:00:00Z' },
    ])
    expect(out[0]).toEqual({
      id: 'a',
      actor: 'yaakovytroutai@gmail.com',
      kind: 'edit',
      message: 'm',
      at: '2026-10-06T00:00:00Z',
    })
    expect(out[1]).toEqual({
      id: 'b',
      actor: null,
      kind: null,
      message: 'U',
      at: '2026-10-05T00:00:00Z',
    })
  })
})
