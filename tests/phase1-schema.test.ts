import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestDb } from './helpers/pglite-db'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

/** Phase 1 foundation schema (migrations 0016-0020). */
describe('phase 1 foundation schema', () => {
  let db: TestDb
  beforeEach(async () => {
    db = await createTestDb()
  })
  afterEach(async () => {
    await db.close()
  })

  async function campaign(name = 'Test campaign', pool = 'jeweler'): Promise<number> {
    const { rows } = await db.query<{ id: number }>('insert into lp.campaigns (name, pool) values ($1, $2) returning id', [name, pool])
    return rows[0].id
  }

  describe('0016 settings, secrets, jobs', () => {
    it('stores settings as JSON keyed by a slug and touches updated_at', async () => {
      await db.query(`insert into lp.settings (key, value, updated_by) values ('workspace.timezone', '"America/New_York"', 'owner')`)
      const { rows } = await db.query<{ value: string }>(`select value from lp.settings where key = 'workspace.timezone'`)
      expect(rows[0].value).toBe('America/New_York')
      await expect(db.query(`insert into lp.settings (key, value) values ('Bad Key', '1')`)).rejects.toThrow()
    })

    it('keeps only ciphertext and last4 for a secret', async () => {
      await db.query(`insert into lp.secrets (key, ciphertext, iv, tag, last4) values ('instantly.api_key', 'Y2lwaGVy', 'aXY=', 'dGFn', 'a1b2')`)
      const { rows } = await db.query<Record<string, unknown>>(`select * from lp.secrets`)
      expect(Object.keys(rows[0]).sort()).toEqual(['ciphertext', 'created_at', 'iv', 'key', 'last4', 'tag', 'updated_at', 'updated_by'])
      await expect(db.query(`insert into lp.secrets (key, ciphertext, iv, tag, last4) values ('x', 'a', 'b', 'c', 'toolong')`)).rejects.toThrow()
    })

    it('gives actors a takes_kinds list (empty by default)', async () => {
      const { rows } = await db.query<{ takes_kinds: string[] }>(`select takes_kinds from lp.actors where id = 'hermes'`)
      expect(rows[0].takes_kinds).toEqual([])
    })

    it('records jobs and their runs, optionally per campaign', async () => {
      const c = await campaign()
      await db.query(`insert into lp.jobs (name, kind, schedule_cron, campaign_id) values ('news_monitor:${c}', 'news_monitor', '0 * * * *', $1)`, [c])
      await db.query(`insert into lp.job_runs (job_name, campaign_id, runner, actor, status) values ('news_monitor:${c}', $1, 'ovh:1', 'system', 'ok')`, [c])
      const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from lp.job_runs where job_name = 'news_monitor:${c}'`)
      expect(rows[0].n).toBe(1)
      await expect(db.query(`insert into lp.job_runs (job_name, status) values ('news_monitor:${c}', 'weird')`)).rejects.toThrow()
    })
  })

  describe('0017 audit log', () => {
    it('accepts edits of any entity type, with the door it came through', async () => {
      await db.query(
        `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by, via) values ('campaign', 1, 'name', 'a', 'b', 'tab', 'ops_api')`,
      )
      await expect(
        db.query(`insert into lp.status_history (entity_type, entity_id, field, via) values ('campaign', 1, 'name', 'carrier_pigeon')`),
      ).rejects.toThrow()
      // Slug-keyed entities use entity_key; a row needs one of the two ids.
      await db.query(
        `insert into lp.status_history (entity_type, entity_key, field, old_value, new_value, changed_by, via) values ('setting', 'workspace.timezone', 'value', null, 'America/New_York', 'owner', 'ui')`,
      )
      await db.query(`insert into lp.status_history (entity_type, entity_key, field) values ('pool', 'dental_clinics', 'label')`)
      await expect(db.query(`insert into lp.status_history (entity_type, field) values ('setting', 'value')`)).rejects.toThrow()
    })

    it('is append-only, except deletes in a maintenance transaction', async () => {
      await db.query(`insert into lp.status_history (entity_type, entity_id, field) values ('setting', 1, 'x')`)
      await expect(db.query(`update lp.status_history set field = 'y'`)).rejects.toThrow(/append-only/)
      await expect(db.query(`delete from lp.status_history`)).rejects.toThrow(/append-only/)
      await db.tx(async (q) => {
        await q.query(`select set_config('lp.maintenance', 'on', true)`)
        await q.query(`delete from lp.status_history where entity_type = 'setting'`)
      })
      // The hatch was transaction-local: outside it, deletes are refused again.
      await db.query(`insert into lp.status_history (entity_type, entity_id, field) values ('setting', 2, 'x')`)
      await expect(db.query(`delete from lp.status_history`)).rejects.toThrow(/append-only/)
    })
  })

  describe('0018 lead events', () => {
    it('only takes registered event types and dedupes on dedupe_key', async () => {
      const { rows } = await db.query<{ id: number }>(`insert into lp.companies (name) values ('Acme') returning id`)
      const co = rows[0].id
      await db.query(`insert into lp.lead_events (type, company_id, source, dedupe_key) values ('email_sent', $1, 'instantly_webhook', 'k1')`, [co])
      await expect(
        db.query(`insert into lp.lead_events (type, company_id, source, dedupe_key) values ('email_sent', $1, 'instantly_webhook', 'k1')`, [co]),
      ).rejects.toThrow()
      await expect(db.query(`insert into lp.lead_events (type, source) values ('not_registered', 'ops_api')`)).rejects.toThrow()
      await db.query(`insert into lp.event_types (key, label, category, source) values ('webinar_attended', 'Attended webinar', 'custom', 'agent')`)
      await db.query(`insert into lp.lead_events (type, company_id, source) values ('webinar_attended', $1, 'ops_api')`, [co])
    })

    it('is append-only but survives the company being deleted', async () => {
      const { rows } = await db.query<{ id: number }>(`insert into lp.companies (name) values ('Gone Co') returning id`)
      const co = rows[0].id
      await db.query(`insert into lp.lead_events (type, company_id, source) values ('email_sent', $1, 'test')`, [co])
      await expect(db.query(`update lp.lead_events set source = 'x'`)).rejects.toThrow(/append-only/)
      await expect(db.query(`delete from lp.lead_events`)).rejects.toThrow(/append-only/)
      await db.query(`delete from lp.companies where id = $1`, [co])
      const ev = await db.query<{ company_id: number | null; type: string }>(`select company_id, type from lp.lead_events`)
      expect(ev.rows).toEqual([{ company_id: null, type: 'email_sent' }])
    })

    it('backfills Instantly touches with the same type mapping the live webhook uses (and re-running adds nothing)', async () => {
      await db.query(
        `insert into lp.campaign_touches (email, campaign_id, event_type, source, external_id) values
           ('a@x.com', 'c1', 'email_sent', 'instantly_webhook', 'e1'),
           ('a@x.com', 'c1', 'lead_meeting_booked', 'instantly_webhook', 'e2'),
           ('a@x.com', 'c1', 'lead_out_of_office', 'instantly_webhook', 'e3')`,
      )
      const sql = readFileSync(join(__dirname, '..', 'db', 'migrations', '0018_lead_events.sql'), 'utf8')
      const backfill = sql.slice(sql.indexOf('insert into lp.lead_events (occurred_at'))
      await db.query(backfill)
      await db.query(backfill)
      const { rows } = await db.query<{ type: string; props: Record<string, unknown> }>(`select type, props from lp.lead_events where source = 'backfill' order by id`)
      expect(rows.map((r) => r.type)).toEqual(['email_sent', 'meeting_booked', 'custom'])
      expect(rows[2].props.instantly_type).toBe('lead_out_of_office')
    })

    it('turns a stage change into a stage_changed lead event, naming the actor', async () => {
      const { rows } = await db.query<{ id: number }>(`insert into lp.companies (name) values ('Gem Co') returning id`)
      const co = rows[0].id
      await db.tx(async (q) => {
        await q.query(`update lp.companies set stage = 'ready' where id = $1`, [co])
      }, 'tab')
      const ev = await db.query<{ type: string; actor: string; props: { from: string; to: string } }>(
        `select type, actor, props from lp.lead_events where company_id = $1`,
        [co],
      )
      expect(ev.rows.length).toBe(1)
      expect(ev.rows[0].type).toBe('stage_changed')
      expect(ev.rows[0].actor).toBe('tab')
      expect(ev.rows[0].props).toMatchObject({ from: 'new', to: 'ready' })
    })
  })

  describe('0019 suppressions', () => {
    it('answers is_suppressed for an email, its domain, and per campaign', async () => {
      const c1 = await campaign('One')
      const c2 = await campaign('Two')
      await db.query(`insert into lp.suppressions (email_norm, reason) values ('a@x.com', 'unsubscribed')`)
      await db.query(`insert into lp.suppressions (domain, reason) values ('competitor.com', 'competitor')`)
      await db.query(`insert into lp.suppressions (email_norm, reason, campaign_id) values ('b@y.com', 'manual', $1)`, [c1])
      const q = async (email: string, c: number | null) =>
        (await db.query<{ s: boolean }>(`select lp.is_suppressed($1, $2) as s`, [email, c])).rows[0].s
      expect(await q(' A@X.com ', null)).toBe(true)
      expect(await q('anyone@Competitor.com', c2)).toBe(true)
      expect(await q('b@y.com', c1)).toBe(true)
      expect(await q('b@y.com', c2)).toBe(false)
      expect(await q('b@y.com', null)).toBe(false)
      expect(await q('fine@ok.com', c1)).toBe(false)
    })

    it('ignores lifted and expired suppressions and needs exactly one of email or domain', async () => {
      await db.query(`insert into lp.suppressions (email_norm, reason, lifted_at) values ('l@x.com', 'manual', now())`)
      await db.query(`insert into lp.suppressions (email_norm, reason, expires_at) values ('e@x.com', 'manual', now() - interval '1 day')`)
      const r = await db.query<{ a: boolean; b: boolean }>(`select lp.is_suppressed('l@x.com') as a, lp.is_suppressed('e@x.com') as b`)
      expect(r.rows[0]).toEqual({ a: false, b: false })
      await expect(db.query(`insert into lp.suppressions (reason) values ('manual')`)).rejects.toThrow()
      await expect(db.query(`insert into lp.suppressions (email_norm, domain, reason) values ('a@b.com', 'b.com', 'manual')`)).rejects.toThrow()
      await expect(db.query(`insert into lp.suppressions (email_norm, reason) values ('Upper@X.com', 'manual')`)).rejects.toThrow()
    })

    it('gives contacts a subscription status and logs consent', async () => {
      const { rows } = await db.query<{ id: number; subscription_status: string }>(
        `insert into lp.contacts (email, email_norm) values ('n@x.com', 'n@x.com') returning id, subscription_status`,
      )
      expect(rows[0].subscription_status).toBe('never_asked')
      await db.query(`insert into lp.consent_log (contact_id, status, source) values ($1, 'subscribed', 'form')`, [rows[0].id])
      await expect(db.query(`update lp.contacts set subscription_status = 'maybe' where id = $1`, [rows[0].id])).rejects.toThrow()
    })
  })

  describe('0020 campaign profiles', () => {
    it('keeps pools as rows: a new industry is a new pool row, unknown pools are refused', async () => {
      const { rows } = await db.query<{ id: string }>(`select id from lp.pools order by sort`)
      expect(rows.map((r) => r.id)).toEqual(['jeweler', 'ai_agency', 'ai_builder', 'other'])
      await expect(campaign('Dental clinics', 'dental_clinics')).rejects.toThrow()
      await db.query(`insert into lp.pools (id, label) values ('dental_clinics', 'Dental clinics')`)
      await campaign('Dental clinics', 'dental_clinics')
      await db.query(`insert into lp.companies (name, segment) values ('Smile Dental', 'dental_clinics')`)
      await expect(db.query(`insert into lp.companies (name, segment) values ('X', 'nope')`)).rejects.toThrow()
      await expect(db.query(`insert into lp.pools (id, label) values ('Not A Slug', 'x')`)).rejects.toThrow()
    })

    it('stores a profile and its approvable items per campaign', async () => {
      await db.query(`insert into lp.pools (id, label) values ('restaurants', 'Restaurants')`)
      const c = await campaign('Restaurants', 'restaurants')
      await db.query(
        `insert into lp.campaign_profiles (campaign_id, industry, icp, utm, kpis) values ($1, 'Restaurants', '{"geographies":["US"]}', '{"source":"cold_email"}', '[{"metric":"reply_rate","target":0.05}]')`,
        [c],
      )
      await db.query(
        `insert into lp.campaign_profile_items (campaign_id, kind, name, value, status, source, rationale) values
           ($1, 'competitor', 'Toast', 'toasttab.com', 'suggested', 'ai', 'Leading restaurant POS'),
           ($1, 'feed', 'Restaurant Business', 'https://www.restaurantbusinessonline.com/rss.xml', 'approved', 'human', null),
           ($1, 'signal_rule', 'Hiring a GM', null, 'approved', 'human', null)`,
        [c],
      )
      await db.query(
        `update lp.campaign_profile_items set verify_status = 'ok', verify_detail = '20 items, newest Oct 9', verified_at = now() where kind = 'feed' and campaign_id = $1`,
        [c],
      )
      await db.query(`insert into lp.campaign_profile_items (campaign_id, kind, name) values ($1, 'search_phrase', 'family restaurant')`, [c])
      const { rows } = await db.query<{ kind: string; status: string }>(
        `select kind, status from lp.campaign_profile_items where campaign_id = $1 and kind <> 'search_phrase' order by id`,
        [c],
      )
      expect(rows).toEqual([
        { kind: 'competitor', status: 'suggested' },
        { kind: 'feed', status: 'approved' },
        { kind: 'signal_rule', status: 'approved' },
      ])
      // One live item per (campaign, kind, name), case-insensitive.
      await expect(db.query(`insert into lp.campaign_profile_items (campaign_id, kind, name) values ($1, 'competitor', 'toast')`, [c])).rejects.toThrow()
      await expect(db.query(`insert into lp.campaign_profile_items (campaign_id, kind, name) values ($1, 'horoscope', 'x')`, [c])).rejects.toThrow()
      // Deleting the campaign removes its profile and items.
      await db.query(`delete from lp.campaigns where id = $1`, [c])
      const left = await db.query<{ n: number }>(
        `select (select count(*) from lp.campaign_profiles)::int + (select count(*) from lp.campaign_profile_items)::int as n`,
      )
      expect(left.rows[0].n).toBe(0)
    })
  })

  describe('0021 integrations (tools hub)', () => {
    it('stores tools as rows and snapshots with honest nulls, per campaign', async () => {
      const c = await campaign('Any campaign')
      await db.query(
        `insert into lp.integrations (id, name, kind, url, api_url, reachable_from, settings_prefix) values ('listmonk', 'Listmonk', 'listmonk', 'http://100.64.0.1:18510', 'http://127.0.0.1:18510', 'tailnet', 'integrations.listmonk')`,
      )
      await db.query(`insert into lp.integration_snapshots (integration_id, campaign_id, metric, value, dims) values ('listmonk', $1, 'listmonk.subscribers', 42, '{"list":"Q4"}')`, [c])
      await db.query(`insert into lp.integration_snapshots (integration_id, metric, value) values ('listmonk', 'listmonk.bounces', null)`)
      const { rows } = await db.query<{ metric: string; value: number | null }>(`select metric, value from lp.integration_snapshots order by id`)
      expect(rows).toEqual([
        { metric: 'listmonk.subscribers', value: 42 },
        { metric: 'listmonk.bounces', value: null },
      ])
      await expect(db.query(`insert into lp.integrations (id, name, kind, url) values ('bad', 'Bad', 'link', 'javascript:alert(1)')`)).rejects.toThrow()
    })
  })
})
