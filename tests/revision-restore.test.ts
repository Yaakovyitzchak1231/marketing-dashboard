import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  businessSnapshot,
  currentHeads,
  restoreRevision,
  saveCheckpoint,
  pinCheckpoint,
} from '@/lib/revisions'

/**
 * Restore-to-revision-N and checkpoint/pin. These are pure lib-level tests
 * against a mock Supabase client: the guardrails (owner/agent authorization,
 * NULL actor refusal, snapshot rewrite, distinct save vs pin) are asserted
 * without a live database, which is never assumed reachable here.
 */

type Result = { data?: unknown; error?: unknown }

function makeQuery(table: string, handler: (t: string, m: string, args: unknown[]) => Result) {
  let method = 'select'
  let payload: unknown[] = []
  let args: unknown[] = []
  const query: Record<string, unknown> = {
    select: (...a: unknown[]) => ((args = a), query),
    insert: (...a: unknown[]) => ((method = 'insert'), (payload = a), (args = a), query),
    update: (...a: unknown[]) => ((method = 'update'), (payload = a), (args = a), query),
    delete: (...a: unknown[]) => ((method = 'delete'), (payload = a), (args = a), query),
    upsert: (...a: unknown[]) => ((method = 'upsert'), (payload = a), (args = a), query),
    eq: (...a: unknown[]) => (args.push(a), query),
    order: (...a: unknown[]) => (args.push(a), query),
    limit: (...a: unknown[]) => (args.push(a), query),
    maybeSingle: () => Promise.resolve(handler(table, method, payload)),
    single: () => Promise.resolve(handler(table, method, payload)),
  }
  query.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(handler(table, method, payload)).then(resolve, reject)
  return query
}

function makeClient(
  handler: (table: string, method: string, args: unknown[]) => Result,
  email: string | null = 'yaakovytroutai@gmail.com',
) {
  return {
    from: (table: string) => makeQuery(table, handler),
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { email } }, error: null })),
    },
  } as never
}

const SNAPSHOT = { title: 'Original subject', hypothesis: 'first guess', status: 'backlog' }

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('businessSnapshot', () => {
  it('keeps only business columns and drops audit/system columns', () => {
    const out = businessSnapshot('ideas', {
      id: 'a',
      title: 'T',
      hypothesis: 'H',
      status: 'backlog',
      revision_id: 'r',
      revision_number: 3,
      change_kind: 'update',
      change_message: 'x',
      actor: 'agent:build-data',
      created_at: 'now',
      updated_at: 'now',
    })
    expect(out).toEqual({ title: 'T', hypothesis: 'H', status: 'backlog' })
  })

  it('returns an empty object for a missing row (never fabricates)', () => {
    expect(businessSnapshot('ideas', null)).toEqual({})
    expect(businessSnapshot('costs', undefined)).toEqual({})
  })
})

describe('restoreRevision authorization', () => {
  it('allows the owner and stamps the restore with the owner, not the original author', async () => {
    const upserts: Record<string, unknown>[] = []
    const handler = (table: string, method: string): Result => {
      if (table === 'revisions' && method === 'select') {
        return { data: { revision_number: 1, actor: 'agent:build-data', change_kind: 'create', snapshot: SNAPSHOT, created_at: 't1' }, error: null }
      }
      if (table === 'ideas' && method === 'select') {
        return { data: { revision_number: 2 }, error: null }
      }
      if (table === 'ideas' && method === 'update') {
        return { data: { id: 'idea-1', ...SNAPSHOT, revision_number: 3 }, error: null }
      }
      if (table === 'revisions' && method === 'upsert') {
        return { data: null, error: null }
      }
      return { data: [], error: null }
    }
    const client = makeClient(handler)
    const result = await restoreRevision(client, { headers: { get: () => null } }, {
      artifactType: 'ideas',
      artifactId: 'idea-1',
      revisionNumber: 1,
      changeMessage: 'rolled back',
    })
    expect('restored' in result).toBe(true)
    expect(result).toHaveProperty('restored')
    expect(result).toHaveProperty('revision')
    if ('revision' in result) {
      expect(result.revision.change_kind).toBe('restore')
      expect(result.revision.actor).toBe('yaakovytroutai@gmail.com')
      expect(result.revision.revision_number).toBe(3)
    }
  })

  it('refuses a NULL actor (the source did not say)', async () => {
    const client = makeClient(() => ({ data: [], error: null }), null)
    const result = await restoreRevision(client, { headers: { get: () => null } }, {
      artifactType: 'ideas',
      artifactId: 'idea-1',
      revisionNumber: 1,
      changeMessage: null,
    })
    expect(result).toEqual({ error: 'Not authorized to restore this object', status: 403 })
  })

  it('refuses an agent that never touched the object', async () => {
    const handler = (_t: string, method: string): Result =>
      method === 'select' ? { data: [], error: null } : { data: null, error: null }
    const client = makeClient(handler)
    const result = await restoreRevision(client, { headers: { get: () => 'agent:build-ui' } }, {
      artifactType: 'ideas',
      artifactId: 'idea-1',
      revisionNumber: 1,
      changeMessage: null,
    })
    expect(result).toEqual({ error: 'Not authorized to restore this object', status: 403 })
  })

  it('refuses a non-owner email that is not an agent', async () => {
    const client = makeClient(() => ({ data: [], error: null }), 'stranger@example.com')
    const result = await restoreRevision(client, { headers: { get: () => null } }, {
      artifactType: 'ideas',
      artifactId: 'idea-1',
      revisionNumber: 1,
      changeMessage: null,
    })
    expect(result).toEqual({ error: 'Not authorized to restore this object', status: 403 })
  })

  it('allows an agent that already touched the object', async () => {
    let revisionSelects = 0
    const handler = (table: string, method: string): Result => {
      if (table === 'revisions' && method === 'select') {
        revisionSelects += 1
        if (revisionSelects === 1) return { data: [{ actor: 'agent:build-data' }], error: null }
        return { data: { revision_number: 1, actor: 'agent:build-data', change_kind: 'create', snapshot: SNAPSHOT, created_at: 't' }, error: null }
      }
      if (table === 'ideas' && method === 'select') {
        return { data: { revision_number: 2 }, error: null }
      }
      if (table === 'ideas' && method === 'update') {
        return { data: { id: 'idea-1', ...SNAPSHOT }, error: null }
      }
      if (table === 'revisions' && method === 'upsert') {
        return { data: null, error: null }
      }
      return { data: [], error: null }
    }
    const client = makeClient(handler)
    const result = await restoreRevision(client, { headers: { get: () => 'agent:build-data' } }, {
      artifactType: 'ideas',
      artifactId: 'idea-1',
      revisionNumber: 1,
      changeMessage: null,
    })
    expect('restored' in result).toBe(true)
  })
})

describe('restoreRevision target validation', () => {
  const actor = { headers: { get: () => 'yaakovytroutai@gmail.com' } }

  it('404s when the revision does not exist', async () => {
    const handler = (table: string, method: string): Result => {
      if (table === 'revisions' && method === 'select') return { data: null, error: null }
      if (table === 'ideas' && method === 'select') return { data: { revision_number: 1 }, error: null }
      return { data: [], error: null }
    }
    const client = makeClient(handler)
    const result = await restoreRevision(client, actor, {
      artifactType: 'ideas', artifactId: 'idea-1', revisionNumber: 9, changeMessage: null,
    })
    expect(result).toEqual({ error: 'Revision not found', status: 404 })
  })

  it('refuses a delete revision', async () => {
    const handler = (table: string, method: string): Result => {
      if (table === 'revisions' && method === 'select') {
        return { data: { revision_number: 2, actor: null, change_kind: 'delete', snapshot: null, created_at: 't' }, error: null }
      }
      if (table === 'ideas' && method === 'select') return { data: { revision_number: 2 }, error: null }
      return { data: [], error: null }
    }
    const client = makeClient(handler)
    const result = await restoreRevision(client, actor, {
      artifactType: 'ideas', artifactId: 'idea-1', revisionNumber: 2, changeMessage: null,
    })
    expect(result).toEqual({ error: 'Cannot restore a delete revision', status: 409 })
  })

  it('refuses a revision with no stored snapshot', async () => {
    const handler = (table: string, method: string): Result => {
      if (table === 'revisions' && method === 'select') {
        return { data: { revision_number: 1, actor: null, change_kind: 'baseline', snapshot: null, created_at: 't' }, error: null }
      }
      if (table === 'ideas' && method === 'select') return { data: { revision_number: 1 }, error: null }
      return { data: [], error: null }
    }
    const client = makeClient(handler)
    const result = await restoreRevision(client, actor, {
      artifactType: 'ideas', artifactId: 'idea-1', revisionNumber: 1, changeMessage: null,
    })
    expect(result).toEqual({ error: 'This revision has no stored snapshot', status: 409 })
  })
})

describe('currentHeads', () => {
  it('keeps only the latest revision per object and ignores non-editable types', () => {
    const handler = (): Result => ({
      data: [
        { artifact_type: 'ideas', artifact_id: 'a', revision_number: 1 },
        { artifact_type: 'ideas', artifact_id: 'a', revision_number: 3 },
        { artifact_type: 'ideas', artifact_id: 'b', revision_number: 2 },
        { artifact_type: 'costs', artifact_id: 'c', revision_number: 1 },
        { artifact_type: 'campaigns', artifact_id: 'd', revision_number: 1 },
      ],
      error: null,
    })
    const client = makeClient(handler)
    return currentHeads(client).then(heads => {
      expect(heads).toEqual([
        { artifact_type: 'costs', artifact_id: 'c', revision_number: 1 },
        { artifact_type: 'ideas', artifact_id: 'a', revision_number: 3 },
        { artifact_type: 'ideas', artifact_id: 'b', revision_number: 2 },
      ])
    })
  })
})

describe('saveCheckpoint', () => {
  it('uses a timestamp name when none is given', async () => {
    const inserts: Record<string, unknown>[] = []
    const handler = (table: string, method: string, args: unknown[]): Result => {
      if (table === 'revisions' && method === 'select') {
        return { data: [{ artifact_type: 'ideas', artifact_id: 'a', revision_number: 1 }], error: null }
      }
      if (table === 'checkpoints' && method === 'insert') {
        inserts.push((args[0] ?? {}) as Record<string, unknown>)
        return { data: { id: 'cp-1', name: 'x', actor: null, heads: [], is_default: false, created_at: 't' }, error: null }
      }
      return { data: [], error: null }
    }
    const client = makeClient(handler)
    const result = await saveCheckpoint(client, { headers: { get: () => null } }, { name: '' })
    expect('checkpoint' in result).toBe(true)
    expect(inserts[0].name).not.toBe('')
    expect(inserts[0].is_default).toBe(false)
  })

  it('save never pins: is_default stays false', async () => {
    const handler = (table: string, method: string, args: unknown[]): Result => {
      if (table === 'revisions' && method === 'select') return { data: [], error: null }
      if (table === 'checkpoints' && method === 'insert') {
        const payload = (args[0] ?? {}) as Record<string, unknown>
        return { data: { id: 'cp-1', name: payload.name, actor: null, heads: [], is_default: payload.is_default, created_at: 't' }, error: null }
      }
      return { data: [], error: null }
    }
    const client = makeClient(handler)
    const result = await saveCheckpoint(client, { headers: { get: () => null } }, { name: 'pre-launch' })
    expect('checkpoint' in result).toBe(true)
    if ('checkpoint' in result) expect(result.checkpoint.is_default).toBe(false)
  })
})

describe('pinCheckpoint', () => {
  it('clears the prior default then pins the new one', async () => {
    const updates: { args: unknown[]; method: string }[] = []
    const handler = (table: string, method: string, args: unknown[]): Result => {
      if (table === 'checkpoints' && method === 'update') {
        updates.push({ method, args })
        const payload = (args[0] ?? {}) as Record<string, unknown>
        return { data: { id: 'cp-2', name: 'n', actor: null, heads: [], is_default: payload.is_default, created_at: 't' }, error: null }
      }
      return { data: [], error: null }
    }
    const client = makeClient(handler)
    const result = await pinCheckpoint(client, { id: 'cp-2' })
    expect('checkpoint' in result).toBe(true)
    if ('checkpoint' in result) expect(result.checkpoint.is_default).toBe(true)
    expect(updates.length).toBe(2)
    expect(updates[0].args[0]).toEqual({ is_default: false })
    expect(updates[1].args[0]).toEqual({ is_default: true })
  })

  it('404s when the checkpoint does not exist', async () => {
    const handler = (table: string, method: string): Result => {
      if (table === 'checkpoints' && method === 'update') return { data: null, error: null }
      return { data: [], error: null }
    }
    const client = makeClient(handler)
    const result = await pinCheckpoint(client, { id: 'missing' })
    expect(result).toEqual({ error: 'Checkpoint not found', status: 404 })
  })
})
