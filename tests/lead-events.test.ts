import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { emitLeadEvent, emitLeadEvents, EventError } from '@/lib/events/emit'
import { ingestInstantlyEvent } from '@/lib/webhooks/instantly'
import { runOp } from '@/lib/ops/dispatch'
import { OpsError } from '@/lib/ops/core'
type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function leadEventsFor(db: TestDb, companyId: number) {
  const { rows } = await db.query<{ type: string; dedupe_key: string | null; props: Record<string, unknown> }>(
    'select type, dedupe_key, props from lp.lead_events where company_id = $1 order by id',
    [companyId],
  )
  return rows
}

describe('emitLeadEvent / emitLeadEvents', () => {
  let db: TestDb
  let co: number
  let contact: number
  beforeAll(async () => {
    db = await createTestDb()
    co = await addCompany(db, { name: 'Gem Co', domain: 'gemco.example' })
    contact = await addContact(db, co, 'owner@gemco.example', 'valid')
  })
  afterAll(async () => db.close())

  it('records a single event by company_id', async () => {
    const r = await emitLeadEvent(db, { type: 'custom', company_id: co, source: 'test', props: { a: 1 } })
    expect(r).toMatchObject({ inserted: true, type: 'custom', company_id: co })
    const rows = await leadEventsFor(db, co)
    expect(rows.find((x) => x.type === 'custom')).toBeTruthy()
  })

  it('resolves company/contact from an email when only email is given', async () => {
    const r = await emitLeadEvent(db, { type: 'custom', email: 'Owner@GemCo.example', source: 'test' })
    expect(r.contact_id).toBe(contact)
    expect(r.company_id).toBe(co)
  })

  it('a duplicate dedupe_key is treated as already recorded, not an error', async () => {
    const first = await emitLeadEvent(db, { type: 'custom', company_id: co, source: 'test', dedupe_key: 'dk-1' })
    expect(first.inserted).toBe(true)
    const second = await emitLeadEvent(db, { type: 'custom', company_id: co, source: 'test', dedupe_key: 'dk-1' })
    expect(second).toMatchObject({ inserted: false, id: null })
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from lp.lead_events where dedupe_key = 'dk-1'")
    expect(rows[0].n).toBe(1)
  })

  it('an unknown type is a typed error', async () => {
    await expect(emitLeadEvent(db, { type: 'not_a_real_type', company_id: co, source: 'test' })).rejects.toThrow(EventError)
  })

  it('emits a batch as one multi-row insert, each resolved independently', async () => {
    const co2 = await addCompany(db, { name: 'Ring Bros', domain: 'ringbros.example' })
    const results = await emitLeadEvents(db, [
      { type: 'custom', company_id: co, source: 'test', props: { i: 1 } },
      { type: 'custom', company_id: co2, source: 'test', props: { i: 2 } },
      { type: 'custom', company_id: co, source: 'test', dedupe_key: 'batch-dk', props: { i: 3 } },
      { type: 'custom', company_id: co, source: 'test', dedupe_key: 'batch-dk', props: { i: 4 } },
    ])
    expect(results.map((r) => r.inserted)).toEqual([true, true, true, false])
    expect(results[1].company_id).toBe(co2)
  })

  it('an unknown type in a batch fails the whole batch (caller validates before writing)', async () => {
    await expect(emitLeadEvents(db, [{ type: 'custom', company_id: co, source: 'test' }, { type: 'nope', company_id: co, source: 'test' }])).rejects.toThrow(EventError)
  })
})

describe('Instantly webhook: lead_events in the same transaction', () => {
  let db: TestDb
  let co: number
  beforeAll(async () => {
    db = await createTestDb()
    co = await addCompany(db, { name: 'Gem Co', domain: 'gemco.example', stage: 'in_campaign' })
    await addContact(db, co, 'owner@gemco.example', 'valid', { status: 'in-Instantly' })
  })
  afterAll(async () => db.close())

  const base = { workspace: 'w', campaign_id: 'instantly-c-1', campaign_name: 'Fees angle' }

  it('a new touch also writes a lead_event with dedupe_key touch:<campaign_touches.id>', async () => {
    const r = await ingestInstantlyEvent(db, { ...base, event_type: 'email_sent', lead_email: 'owner@gemco.example', timestamp: '2026-10-11T12:00:00Z', step: 1 })
    expect(r.stored).toBe(true)
    const { rows: touch } = await db.query<{ id: number }>("select id from lp.campaign_touches where event_type = 'email_sent' order by id desc limit 1")
    const { rows: ev } = await db.query<{ type: string; dedupe_key: string }>('select type, dedupe_key from lp.lead_events where dedupe_key = $1', [`touch:${touch[0].id}`])
    expect(ev[0]).toMatchObject({ type: 'email_sent', dedupe_key: `touch:${touch[0].id}` })
  })

  it('maps lead_meeting_booked to the seeded meeting_booked type', async () => {
    await ingestInstantlyEvent(db, { ...base, event_type: 'lead_meeting_booked', lead_email: 'owner@gemco.example', timestamp: '2026-10-11T13:00:00Z' })
    const rows = await leadEventsFor(db, co)
    expect(rows.find((r) => r.type === 'meeting_booked')).toBeTruthy()
  })

  it('an Instantly type with no mapping lands as custom with props.instantly_type', async () => {
    await ingestInstantlyEvent(db, { ...base, event_type: 'lead_out_of_office', lead_email: 'owner@gemco.example', timestamp: '2026-10-11T13:30:00Z' })
    const rows = await leadEventsFor(db, co)
    const custom = rows.filter((r) => r.type === 'custom')
    expect(custom.some((r) => r.props?.instantly_type === 'lead_out_of_office')).toBe(true)
  })

  it('re-delivering the same event is idempotent: no new touch, no new lead_event', async () => {
    const before = await leadEventsFor(db, co)
    const { rows: touchesBefore } = await db.query<{ n: number }>("select count(*)::int as n from lp.campaign_touches")
    const e = { ...base, event_type: 'email_sent', lead_email: 'owner@gemco.example', timestamp: '2026-10-11T12:00:00Z', step: 1 }
    const r = await ingestInstantlyEvent(db, e)
    expect(r.duplicate).toBe(true)
    const after = await leadEventsFor(db, co)
    const { rows: touchesAfter } = await db.query<{ n: number }>("select count(*)::int as n from lp.campaign_touches")
    expect(after.length).toBe(before.length)
    expect(touchesAfter[0].n).toBe(touchesBefore[0].n)
  })

  it('maps the Instantly campaign id to the dashboard campaign when lp.campaigns.instantly_campaign_id links them', async () => {
    const { rows: camp } = await db.query<{ id: number }>(
      `insert into lp.campaigns (name, pool, instantly_campaign_id) values ('Fees angle', 'jeweler', 'instantly-c-linked') returning id`,
    )
    await ingestInstantlyEvent(db, { workspace: 'w', campaign_id: 'instantly-c-linked', campaign_name: 'Fees angle', event_type: 'email_opened', lead_email: 'owner@gemco.example', timestamp: '2026-10-11T14:00:00Z' })
    const { rows } = await db.query<{ campaign_id: number | null; instantly_campaign_id: string | null }>(
      "select campaign_id, instantly_campaign_id from lp.lead_events where type = 'email_opened' and instantly_campaign_id = 'instantly-c-linked'",
    )
    expect(rows[0]).toMatchObject({ campaign_id: camp[0].id, instantly_campaign_id: 'instantly-c-linked' })
  })

  it('unsubscribe adds a global suppression, subscription_status and a consent_log row', async () => {
    const co2 = await addCompany(db, { name: 'Ring Bros', domain: 'ringbros.example', stage: 'in_campaign' })
    const c2 = await addContact(db, co2, 'sub@ringbros.example', 'valid', { status: 'in-Instantly' })
    await ingestInstantlyEvent(db, { ...base, event_type: 'lead_unsubscribed', lead_email: 'sub@ringbros.example', timestamp: '2026-10-11T15:00:00Z' })
    const { rows: supp } = await db.query<{ reason: string; source: string; campaign_id: number | null }>(
      "select reason, source, campaign_id from lp.suppressions where email_norm = 'sub@ringbros.example'",
    )
    expect(supp[0]).toMatchObject({ reason: 'unsubscribed', source: 'instantly_webhook', campaign_id: null })
    const { rows: contactRow } = await db.query<{ subscription_status: string }>('select subscription_status from lp.contacts where id = $1', [c2])
    expect(contactRow[0].subscription_status).toBe('unsubscribed')
    const { rows: consent } = await db.query<{ status: string; source: string }>('select status, source from lp.consent_log where contact_id = $1', [c2])
    expect(consent[0]).toMatchObject({ status: 'unsubscribed', source: 'instantly_webhook' })
  })

  it('a hard bounce also adds a global suppression and marks the contact bounced', async () => {
    const co3 = await addCompany(db, { name: 'Held Jewelers', domain: 'held.example', stage: 'in_campaign' })
    const c3 = await addContact(db, co3, 'bounced@held.example', 'valid', { status: 'in-Instantly' })
    await ingestInstantlyEvent(db, { ...base, event_type: 'email_bounced', lead_email: 'bounced@held.example', timestamp: '2026-10-11T16:00:00Z' })
    const { rows: supp } = await db.query<{ reason: string }>("select reason from lp.suppressions where email_norm = 'bounced@held.example'")
    expect(supp[0].reason).toBe('bounced')
    const { rows: contactRow } = await db.query<{ subscription_status: string }>('select subscription_status from lp.contacts where id = $1', [c3])
    expect(contactRow[0].subscription_status).toBe('bounced')
  })

  it('a suppression already added for this email is not duplicated on a second bounce', async () => {
    const { rows: before } = await db.query<{ n: number }>("select count(*)::int as n from lp.suppressions where email_norm = 'bounced@held.example'")
    await ingestInstantlyEvent(db, { ...base, event_type: 'email_bounced', lead_email: 'bounced@held.example', timestamp: '2026-10-11T17:00:00Z', email_id: 'second' })
    const { rows: after } = await db.query<{ n: number }>("select count(*)::int as n from lp.suppressions where email_norm = 'bounced@held.example'")
    expect(after[0].n).toBe(before[0].n)
  })
})

describe('backfilled touch + live webhook with the same touch never duplicate', () => {
  it('a touch inserted directly (simulating a pre-existing / backfilled touch) backfills its own lead_event once; a later webhook redelivery of the identical event adds nothing', async () => {
    const db = await createTestDb()
    try {
      const co = await addCompany(db, { name: 'Old Co', domain: 'old.example', stage: 'in_campaign' })
      await addContact(db, co, 'x@old.example', 'valid', { status: 'in-Instantly' })
      // Simulate a touch that existed before this code ran (same shape 0018's backfill would have found),
      // with the external_id ingestInstantlyEvent itself would compute for this exact event.
      const { externalId } = await import('@/lib/webhooks/instantly')
      const e = { workspace: 'w', campaign_id: 'c-old', campaign_name: 'Old', event_type: 'email_sent', lead_email: 'x@old.example', timestamp: '2026-10-01T00:00:00Z', step: 1 }
      const ext = externalId(e)
      const { rows: touch } = await db.query<{ id: number }>(
        `insert into lp.campaign_touches (company_id, email, campaign_id, campaign_name, event_type, occurred_at, source, external_id)
         values ($1, $2, $3, $4, $5, $6, 'instantly_webhook', $7) returning id`,
        [co, 'x@old.example', e.campaign_id, e.campaign_name, e.event_type, e.timestamp, ext],
      )
      // Backfill-style lead_event for that pre-existing touch.
      await db.query(
        `insert into lp.lead_events (occurred_at, type, company_id, source, props, dedupe_key) values ($1, 'email_sent', $2, 'backfill', '{}'::jsonb, $3)`,
        [e.timestamp, co, `touch:${touch[0].id}`],
      )
      // A live redelivery of the exact same event: same external_id, so the touch insert conflicts and
      // ingestInstantlyEvent returns early, before it ever tries to emit a lead_event.
      const r = await ingestInstantlyEvent(db, e)
      expect(r.duplicate).toBe(true)
      const { rows } = await db.query<{ n: number }>('select count(*)::int as n from lp.lead_events where dedupe_key = $1', [`touch:${touch[0].id}`])
      expect(rows[0].n).toBe(1)
    } finally {
      await db.close()
    }
  })
})

describe('Ops: track_event, track_events, recent_lead_events, list_event_types, register_event_type', () => {
  let db: TestDb
  let co: number
  beforeAll(async () => {
    db = await createTestDb()
    co = await addCompany(db, { name: 'Gem Co', domain: 'gemco.example' })
  })
  afterAll(async () => db.close())

  it('track_event as an agent records the event with that actor', async () => {
    const r = (await runOp(db, 'instantly-ai', 'track_event', { type: 'custom', company_id: co, props: { x: 1 } })) as { inserted: boolean; id: number }
    expect(r.inserted).toBe(true)
    const { rows } = await db.query<{ actor: string; source: string }>('select actor, source from lp.lead_events where id = $1', [r.id])
    expect(rows[0]).toMatchObject({ actor: 'instantly-ai', source: 'ops_api' })
  })

  it('track_event rejects an unregistered type', async () => {
    await expect(runOp(db, 'owner', 'track_event', { type: 'totally_unknown', company_id: co })).rejects.toThrow(OpsError)
  })

  it('track_event requires an identity (company_id, contact_id or email)', async () => {
    await expect(runOp(db, 'owner', 'track_event', { type: 'custom' })).rejects.toThrow(OpsError)
  })

  it('register_event_type adds a new key that track_event can then use', async () => {
    const t = (await runOp(db, 'owner', 'register_event_type', { key: 'review_posted', label: 'Review posted', category: 'signal' })) as { key: string }
    expect(t.key).toBe('review_posted')
    const r = (await runOp(db, 'owner', 'track_event', { type: 'review_posted', company_id: co })) as { inserted: boolean }
    expect(r.inserted).toBe(true)
  })

  it('register_event_type validates the slug and category', async () => {
    await expect(runOp(db, 'owner', 'register_event_type', { key: 'Not A Slug', label: 'x', category: 'signal' })).rejects.toThrow(OpsError)
    await expect(runOp(db, 'owner', 'register_event_type', { key: 'ok_key', label: 'x', category: 'not_a_category' })).rejects.toThrow(OpsError)
  })

  it('track_events rejects over the batch limit', async () => {
    const events = Array.from({ length: 501 }, () => ({ type: 'custom', company_id: co }))
    await expect(runOp(db, 'owner', 'track_events', { events })).rejects.toThrow(OpsError)
  })

  it('track_events reports a per-item result: a bad item never fails the others', async () => {
    const results = (await runOp(db, 'owner', 'track_events', {
      events: [
        { type: 'custom', company_id: co, props: { i: 1 } },
        { type: 'nope_not_registered', company_id: co },
        { type: 'custom' }, // no identity
        { type: 'custom', company_id: co, props: { i: 2 } },
      ],
    })) as { ok: boolean }[]
    expect(results.map((r) => r.ok)).toEqual([true, false, false, true])
  })

  it('recent_lead_events requires at least one filter', async () => {
    await expect(runOp(db, 'owner', 'recent_lead_events', {})).rejects.toThrow(OpsError)
  })

  it('recent_lead_events returns a company\'s timeline newest-first with the campaign name', async () => {
    const { rows: camp } = await db.query<{ id: number }>(`insert into lp.campaigns (name, pool) values ('Timeline test', 'jeweler') returning id`)
    await runOp(db, 'owner', 'track_event', { type: 'custom', company_id: co, campaign_id: camp[0].id, occurred_at: '2026-10-11T10:00:00Z' })
    await runOp(db, 'owner', 'track_event', { type: 'custom', company_id: co, campaign_id: camp[0].id, occurred_at: '2026-10-11T11:00:00Z' })
    const rows = (await runOp(db, 'owner', 'recent_lead_events', { company_id: co, limit: 2 })) as { occurred_at: string; campaign_name: string }[]
    expect(rows.length).toBe(2)
    expect(new Date(rows[0].occurred_at).getTime()).toBeGreaterThanOrEqual(new Date(rows[1].occurred_at).getTime())
    expect(rows[0].campaign_name).toBe('Timeline test')
  })

  it('list_event_types lists the seeded types, active by default', async () => {
    const rows = (await runOp(db, 'owner', 'list_event_types', {})) as { key: string }[]
    expect(rows.map((r) => r.key)).toContain('email_sent')
    expect(rows.map((r) => r.key)).toContain('verified')
  })
})

