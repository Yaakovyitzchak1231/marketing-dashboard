import { describe, it, expect } from 'vitest'
import { isMissingTableError, listFieldDefsSafe, type FieldDefRow } from '@/lib/fields/registry'
import type { Queryable } from '@/lib/db/types'

/** A fake db standing in for a preview database that has never run migration
 *  0025 -- every query against lp.field_defs fails the way Postgres fails
 *  against a table that was never created. */
function missingTableDb(): Queryable {
  return {
    query: async () => {
      throw new Error('relation "lp.field_defs" does not exist')
    },
  } as unknown as Queryable
}

/** A fake db for a genuinely different failure -- must NOT be treated as a
 *  missing-migration state. */
function brokenDb(): Queryable {
  return {
    query: async () => {
      throw new Error('connection terminated unexpectedly')
    },
  } as unknown as Queryable
}

function workingDb(rows: Partial<FieldDefRow>[]): Queryable {
  return {
    query: async () => ({ rows }),
  } as unknown as Queryable
}

describe('isMissingTableError', () => {
  it('matches a Postgres "does not exist" message (missing table or missing column)', () => {
    expect(isMissingTableError(new Error('relation "lp.field_defs" does not exist'))).toBe(true)
    expect(isMissingTableError(new Error('column "custom" does not exist'))).toBe(true)
  })
  it('does not match an unrelated error', () => {
    expect(isMissingTableError(new Error('connection terminated unexpectedly'))).toBe(false)
    expect(isMissingTableError(new Error('duplicate key value violates unique constraint'))).toBe(false)
    expect(isMissingTableError(null)).toBe(false)
    expect(isMissingTableError('not an error object')).toBe(false)
  })
})

describe('listFieldDefsSafe', () => {
  it('returns an empty list with needsMigration: true when lp.field_defs does not exist yet (preview DBs, prod before its next deploy)', async () => {
    const result = await listFieldDefsSafe(missingTableDb(), { entity: 'contact' })
    expect(result).toEqual({ defs: [], needsMigration: true })
  })

  it('re-throws a genuinely different error instead of swallowing it', async () => {
    await expect(listFieldDefsSafe(brokenDb(), { entity: 'contact' })).rejects.toThrow('connection terminated unexpectedly')
  })

  it('returns the real rows with needsMigration: false once the table exists', async () => {
    const row = {
      id: 1, entity: 'company' as const, key: 'store_size', label: 'Store size', type: 'number' as const, options: [],
      campaign_id: null, sort: 100, archived_at: null, created_by: null, created_at: '2026-10-11T00:00:00Z', updated_at: '2026-10-11T00:00:00Z',
    }
    const result = await listFieldDefsSafe(workingDb([row]), { entity: 'company' })
    expect(result.needsMigration).toBe(false)
    expect(result.defs).toHaveLength(1)
    expect(result.defs[0].key).toBe('store_size')
  })
})
