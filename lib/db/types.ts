/**
 * The one seam every module talks to the database through. Implemented by
 * node-postgres in production (lib/db/pg.ts) and by PGlite (real Postgres in
 * WASM) in tests, so the same SQL runs in both.
 */
export interface QueryResult<T> {
  rows: T[]
  rowCount?: number | null
}

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>
}

export interface Db extends Queryable {
  /**
   * Run fn inside one transaction. `actor` is written to the lp.actor setting
   * for the transaction, so status_history rows name who made the change.
   */
  tx<T>(fn: (q: Queryable) => Promise<T>, actor?: string): Promise<T>
}
