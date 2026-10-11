import { describe, it, expect } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { listSegments } from '@/lib/segments/store'
import type { Queryable } from '@/lib/db/types'

/**
 * Plan 2.6's "From segment" form on the campaign page (app/campaigns/[id]/page.tsx)
 * guards its listSegments() read the same way lib/setup/db-status.ts and the
 * scoring settings page do: catch an error whose message matches /does not
 * exist/i and show "Needs migration 0024" instead of crashing. Previews never
 * run migrations, so a preview database is exactly this case. This test proves
 * listSegments() actually throws that recognizable shape against a database
 * with none of migration 0024's tables -- the fact the page's catch depends on.
 */
describe('campaign page "From segment" migration guard (plan 2.6)', () => {
  it('listSegments() throws a "does not exist" error on a database with no migrations', async () => {
    const pg = new PGlite()
    const q: Queryable = {
      async query<T>(text: string, params?: unknown[]) {
        const r = await pg.query<T>(text, params as unknown[] | undefined)
        return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length }
      },
    }
    await expect(listSegments(q, { includeArchived: false })).rejects.toThrow(/does not exist/i)
    await pg.close()
  })
})
