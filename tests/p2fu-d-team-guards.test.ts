import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, readdirSync, copyFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ getDb: () => null, dbConfigured: () => false }))

import { createTestDb } from './helpers/pglite-db'
import { applyMigrations } from '@/scripts/lib/migrate.mjs'
import { opsGate } from '@/lib/ops/gate'
import { changeTeamMemberRole, removeTeamMember, TeamError } from '@/lib/team/store'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
const REAL = join(__dirname, '..', 'db', 'migrations')

/** node-postgres-shaped client over PGlite (same as tests/db-migrate.test.ts). */
function client(pg: PGlite) {
  return {
    async query(text: string, params?: unknown[]) {
      if (params && params.length) return pg.query(text, params)
      const all = await pg.exec(text)
      return all[all.length - 1] ?? { rows: [] }
    },
  }
}

const HUMAN = `insert into lp.actors (id, kind, display_name, email, role, active) values ('nina', 'human', 'Nina', 'nina@example.com', 'editor', true)`

describe('finding 5: team changes with no acting person fail closed (0051)', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
    await db.tx((q) => q.query(`insert into lp.actors (id, kind, display_name, email, role, active) values ('ed', 'human', 'Ed', 'ed@example.com', 'editor', true)`), 'owner')
  })
  afterAll(async () => { await db.close() })

  it('a plain db.query outside db.tx cannot add, re-role, deactivate, re-email or delete a person', async () => {
    await expect(db.query(HUMAN)).rejects.toThrow(/need to say who/)
    await expect(db.query(`update lp.actors set role = 'owner' where id = 'ed'`)).rejects.toThrow(/need to say who/)
    await expect(db.query(`update lp.actors set active = false where id = 'ed'`)).rejects.toThrow(/need to say who/)
    await expect(db.query(`update lp.actors set email = 'evil@example.com' where id = 'ed'`)).rejects.toThrow(/need to say who/)
    await expect(db.query(`delete from lp.actors where id = 'ed'`)).rejects.toThrow(/need to say who/)
    const r = await db.query<{ role: string; active: boolean; email: string }>(`select role, active, email from lp.actors where id = 'ed'`)
    expect(r.rows[0]).toEqual({ role: 'editor', active: true, email: 'ed@example.com' })
  })

  it('a transaction that never set lp.actor is refused too', async () => {
    await expect(db.tx((q) => q.query(HUMAN))).rejects.toThrow(/need to say who/)
  })

  it('agent rows and housekeeping columns are not team changes and still work without an actor', async () => {
    await db.query(`insert into lp.actors (id, kind, display_name) values ('bot-x', 'agent', 'Bot X')`)
    await db.query(`update lp.actors set last_seen_at = now(), status_note = 'hi' where id = 'bot-x'`)
    await db.query(`update lp.actors set last_seen_at = now() where id = 'owner'`)
    await db.query(`update lp.actors set last_seen_at = now() where id = 'ed'`)
    await db.query(`delete from lp.actors where id = 'bot-x'`)
  })

  it('the owner path through db.tx still works', async () => {
    await db.tx((q) => q.query(HUMAN), 'owner')
    await db.tx((q) => q.query(`update lp.actors set role = 'viewer' where id = 'nina'`), 'owner')
    const r = await db.query<{ role: string }>(`select role from lp.actors where id = 'nina'`)
    expect(r.rows[0].role).toBe('viewer')
  })

  it('a non-owner actor is still refused (0050 rule unchanged)', async () => {
    await expect(db.tx((q) => q.query(`update lp.actors set role = 'owner' where id = 'ed'`), 'ed')).rejects.toThrow(/Only an owner/)
  })

  it('the migration flag is transaction-local: it allows the write, then is gone', async () => {
    await db.tx(async (q) => {
      await q.query("select set_config('lp.migration', 'on', true)")
      await q.query(`update lp.actors set display_name = 'Ed I.', role = 'viewer' where id = 'ed'`)
    })
    await expect(db.query(`update lp.actors set role = 'editor' where id = 'ed'`)).rejects.toThrow(/need to say who/)
  })

  it('no API key can be stored for the legacy owner actor', async () => {
    await expect(
      db.query(`insert into lp.agent_keys (actor_id, key_hash, hint) values ('owner', 'h-owner', 'abcd')`),
    ).rejects.toThrow(/agent_keys_not_legacy_owner/)
    await db.query(`insert into lp.agent_keys (actor_id, key_hash, hint) values ('tab', 'h-tab', 'abcd')`)
    await expect(db.query(`update lp.agent_keys set actor_id = 'owner' where key_hash = 'h-tab'`)).rejects.toThrow(/agent_keys_not_legacy_owner/)
  })
})

describe('finding 5: an ops token mapped to the legacy owner is refused at the gate', () => {
  it('OPS_AGENT_TOKENS "owner:<token>" gets 403; an agent token still passes', async () => {
    vi.stubEnv('OPS_AGENT_TOKENS', 'owner:owner-token-0123456789abcdefghij,tab:tab-token-0123456789abcdefghijkl')
    try {
      const bad = await opsGate(new Request('https://x/api/ops', { headers: { Authorization: 'Bearer owner-token-0123456789abcdefghij' } }))
      expect(bad.ok).toBe(false)
      if (!bad.ok) {
        expect(bad.response.status).toBe(403)
        expect((await bad.response.json()).error).toMatch(/mapped to 'owner'/)
      }
      const good = await opsGate(new Request('https://x/api/ops', { headers: { Authorization: 'Bearer tab-token-0123456789abcdefghijkl' } }))
      expect(good).toMatchObject({ ok: true, agent: 'tab' })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('finding 5: migrations still replay through the runner', () => {
  it('applies every real migration, and a later migration that seeds a person still works (runner sets lp.migration)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-d-'))
    for (const f of readdirSync(REAL).filter((x) => x.endsWith('.sql'))) copyFileSync(join(REAL, f), join(dir, f))
    writeFileSync(
      join(dir, '9999_seed_person.sql'),
      `insert into lp.actors (id, kind, display_name, email, role, active) values ('seeded', 'human', 'Seeded', 'seeded@example.com', 'viewer', true);`,
    )
    const pg = new PGlite()
    const r = await applyMigrations(client(pg), { dir })
    expect(r.failed).toBeNull()
    expect(r.applied).toContain('0051_team_changes_fail_closed.sql')
    expect(r.applied).toContain('0052_keep_an_active_owner.sql')
    expect(r.applied).toContain('9999_seed_person.sql')
    const s = await pg.query<{ id: string }>(`select id from lp.actors where id = 'seeded'`)
    expect(s.rows.length).toBe(1)
    // and outside the runner the same write is refused
    await expect(pg.query(`insert into lp.actors (id, kind, display_name, email, role) values ('late', 'human', 'Late', 'late@example.com', 'viewer')`)).rejects.toThrow(/need to say who/)
    await pg.close()
  })
})

describe('finding 6: never zero active human owners (0052)', () => {
  let db: TestDb
  const asOwner = (sql: string, who = 'owner') => db.tx((q) => q.query(sql), who)
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => { await db.close() })

  it('the built-in owner row cannot be demoted, deactivated or deleted, even with another owner present', async () => {
    await asOwner(`insert into lp.actors (id, kind, display_name, email, role, active) values ('olga', 'human', 'Olga', 'olga@example.com', 'owner', true)`)
    await expect(asOwner(`update lp.actors set role = 'editor' where id = 'owner'`, 'olga')).rejects.toThrow(/built-in owner/)
    await expect(asOwner(`update lp.actors set active = false where id = 'owner'`, 'olga')).rejects.toThrow(/built-in owner/)
    await expect(asOwner(`delete from lp.actors where id = 'owner'`, 'olga')).rejects.toThrow(/built-in owner|foreign key/)
    const r = await db.query<{ role: string; active: boolean }>(`select role, active from lp.actors where id = 'owner'`)
    expect(r.rows[0]).toEqual({ role: 'owner', active: true })
  })

  it('with the built-in row not an owner (an older database), the last owner cannot be demoted, deactivated or deleted', async () => {
    // Set up the scenario as maintenance would: legacy row already not an owner, Olga the only owner.
    await db.tx(async (q) => {
      await q.query("select set_config('lp.migration', 'on', true)")
      await q.query(`update lp.actors set role = 'editor' where id = 'owner'`)
    })
    await expect(asOwner(`update lp.actors set role = 'editor' where id = 'olga'`, 'olga')).rejects.toThrow(/last owner/)
    await expect(asOwner(`update lp.actors set active = false where id = 'olga'`, 'olga')).rejects.toThrow(/last owner/)
    await expect(asOwner(`delete from lp.actors where id = 'olga'`, 'olga')).rejects.toThrow(/last owner/)
    // through the team store: the app check answers first, as a plain TeamError
    await expect(changeTeamMemberRole(db, 'olga', 'olga', 'viewer')).rejects.toThrow(TeamError)
    await expect(removeTeamMember(db, 'olga', 'olga')).rejects.toThrow(/last owner/)
  })

  it('with two owners, demoting or removing one works; demoting both in one statement is refused', async () => {
    await asOwner(`insert into lp.actors (id, kind, display_name, email, role, active) values ('pat', 'human', 'Pat', 'pat@example.com', 'owner', true)`, 'olga')
    // Refused either way: by 0052 (no owner left) or by 0050/0051 once the acting owner's own row is demoted mid-statement.
    await expect(asOwner(`update lp.actors set role = 'editor' where id in ('olga', 'pat')`, 'olga')).rejects.toThrow(/last owner|Only an owner/)
    expect((await db.query(`select 1 from lp.actors where role = 'owner' and active and id in ('olga', 'pat')`)).rows.length).toBe(2)
    await asOwner(`update lp.actors set role = 'editor' where id = 'pat'`, 'olga')
    await asOwner(`update lp.actors set role = 'owner' where id = 'pat'`, 'olga')
    await asOwner(`update lp.actors set active = false where id = 'pat'`, 'olga')
    const r = await db.query<{ id: string }>(`select id from lp.actors where kind = 'human' and role = 'owner' and active order by id`)
    expect(r.rows.map((x) => x.id)).toEqual(['olga'])
  })

  it('a race the app check misses is still caught by the database and shown as a plain message', async () => {
    // Promote pat back, then have the DB see a demote of the last one inside the store path:
    // removing pat is fine, removing olga after that is refused with the plain words.
    await asOwner(`update lp.actors set active = true where id = 'pat'`, 'olga')
    await removeTeamMember(db, 'olga', 'pat')
    const err = await removeTeamMember(db, 'olga', 'olga').catch((e) => e)
    expect(err).toBeInstanceOf(TeamError)
    expect(err.message).toMatch(/last owner/)
  })

  it('changing a non-owner is unaffected', async () => {
    await asOwner(`insert into lp.actors (id, kind, display_name, email, role, active) values ('vic', 'human', 'Vic', 'vic@example.com', 'viewer', true)`, 'olga')
    await asOwner(`update lp.actors set role = 'editor' where id = 'vic'`, 'olga')
    await asOwner(`update lp.actors set active = false where id = 'vic'`, 'olga')
    await asOwner(`delete from lp.actors where id = 'vic'`, 'olga')
    const r = await db.query(`select 1 from lp.actors where id = 'vic'`)
    expect(r.rows.length).toBe(0)
  })
})
