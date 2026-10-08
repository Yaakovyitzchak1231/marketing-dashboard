#!/usr/bin/env node
/**
 * Seed a LOCAL lead database with ~60 synthetic leads for screenshots and
 * clicking around. Every name, email and reply here is made up.
 *
 *   DATABASE_URL=postgresql://tab:tab@localhost/leads_ui node scripts/seed-dev.mjs [--reset]
 *
 * Refuses to run against anything but localhost / 127.0.0.1, so it can never
 * write fake rows into a real database. --reset clears the lp lead tables first.
 */
import pg from 'pg'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set.')
  process.exit(1)
}
const host = new URL(url).hostname
if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
  console.error(`Refusing to seed ${host}: seed-dev only writes to a local database.`)
  process.exit(1)
}

// Deterministic pseudo-random so screenshots are repeatable.
let s = 20261008
const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648)
const pick = (a) => a[Math.floor(rnd() * a.length)]

const PREFIX = ['Golden', 'Heritage', 'Main Street', 'Bella', 'Diamond', 'Laurel', 'Harbor', 'Oak & Stone', 'Crescent', 'Rosewood', 'Old Town', 'Sterling', 'Northgate', 'Willow', 'Brightline', 'Cedar', 'Lumen', 'Hartley', 'Avalon', 'Marigold']
const SUFFIX = ['Jewelers', 'Jewelry Co', 'Fine Jewelry', 'Diamonds', 'Goldsmiths', 'Jewelry & Repair', 'Bridal & Diamond']
const PLACES = [
  ['Baltimore', 'MD'], ['Towson', 'MD'], ['Annapolis', 'MD'], ['Frederick', 'MD'], ['Bethesda', 'MD'],
  ['Richmond', 'VA'], ['Arlington', 'VA'], ['Norfolk', 'VA'], ['Philadelphia', 'PA'], ['Lancaster', 'PA'],
  ['Pittsburgh', 'PA'], ['Wilmington', 'DE'], ['Newark', 'NJ'], ['Princeton', 'NJ'], ['Brooklyn', 'NY'],
  ['Albany', 'NY'], ['Raleigh', 'NC'], ['Charlotte', 'NC'],
]
const OWNERS = ['Ruth Adler', 'Marcus Bell', 'Dana Kim', 'Samuel Ortiz', 'Leah Cohen', 'Victor Hale', 'Priya Nair', 'Tom Russo', 'Anna Weiss', 'Grace Liu', null, null, null]
const STAGE_PLAN = [
  ...Array(16).fill('new'), ...Array(9).fill('researched'), ...Array(8).fill('ready'), ...Array(9).fill('in_campaign'),
  ...Array(6).fill('contacted'), ...Array(4).fill('replied'), ...Array(3).fill('interested'), 'meeting', 'meeting', 'won', 'lost', 'do_not_contact',
]
const CAMPAIGNS = ['Jewelers: card fees angle', 'Jewelers: same-day payouts', 'AI agencies: white-label']
const REPLIES = [
  ['Re: card fees at your store', 'Honestly our processor has been creeping up. What would this cost us at about $40k a month?'],
  ['Re: quick question', 'Can you send me something I can read? We are in the middle of the holiday rush.'],
  ['Re: same-day payouts', 'We already use Square, is this different?'],
  ['Re: card fees at your store', 'Not right now, maybe after the new year.'],
  ['Re: for your shop', 'Yes, I would like to see a demo. Thursday works.'],
]

const pool = new pg.Pool({ connectionString: url })
const c = await pool.connect()
try {
  await c.query('begin')
  await c.query("select set_config('lp.actor', 'system', true)")
  if (process.argv.includes('--reset')) {
    await c.query('alter table lp.events disable trigger events_no_update')
    await c.query('truncate lp.events, lp.comments, lp.notifications, lp.campaign_touches, lp.verification_results, lp.enrichment, lp.sources, lp.contacts, lp.status_history, lp.tasks, lp.companies restart identity cascade')
    await c.query('alter table lp.events enable trigger events_no_update')
  }
  const ids = []
  for (let i = 0; i < 62; i++) {
    const agency = i >= 56
    const name = agency ? `${pick(['Flowcraft', 'Northwind', 'Signal', 'Kestrel', 'Loop', 'Basalt'])} ${pick(['AI', 'Automation', 'Agents', 'Labs'])} ${i}` : `${pick(PREFIX)} ${pick(SUFFIX)}`
    const [city, state] = i % 23 === 7 ? [null, null] : pick(PLACES)
    const stage = STAGE_PLAN[i] ?? 'new'
    const domain = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '')}${i}.example.com`
    const research = stage === 'new' ? pick(['needs_research', 'needs_research', 'needs_research', 'failed', 'queued']) : 'researched'
    const owner = research === 'researched' ? pick(OWNERS) : null
    const { rows } = await c.query(
      `insert into lp.companies (name, segment, website, website_domain, city, state, stage, research_status, owner_name, phone, last_researched_at, created_by, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, case when $8 = 'researched' then now() - interval '3 days' end, 'system', now() - ($11 || ' days')::interval)
       returning id`,
      [name, agency ? 'ai_agency' : 'jeweler', `https://${domain}`, domain, city, state, stage, research, owner,
       `(410) 555-${String(1000 + i).slice(-4)}`, String(Math.floor(rnd() * 40) + 1)],
    )
    const id = rows[0].id
    ids.push({ id, name, stage, domain, owner })
    await c.query(`insert into lp.sources (company_id, kind, source_ref, url) values ($1, $2, $3, $4)`,
      [id, i < 40 ? 'sheet_import' : 'engine', i < 40 ? `Leads!row ${100 + i}` : 'find_leads:1', `https://${domain}`])
    if (stage === 'new' && research !== 'researched') continue
    // contacts
    const verif = ['ready', 'in_campaign', 'contacted', 'replied', 'interested', 'meeting', 'won'].includes(stage)
      ? pick(['valid', 'valid', 'valid', 'catch_all'])
      : pick(['unverified', 'unverified', 'valid', 'invalid', 'unknown'])
    const first = owner ? owner.split(' ')[0].toLowerCase() : null
    const emails = [first ? `${first}@${domain}` : null, `info@${domain}`].filter(Boolean)
    for (const [k, email] of emails.entries()) {
      const v = k === 0 ? verif : pick(['valid', 'unverified', 'catch_all'])
      const status = ['in_campaign', 'contacted'].includes(stage) ? 'in-Instantly' : ['replied', 'interested', 'meeting', 'won'].includes(stage) ? 'replied' : v === 'valid' ? 'valid-ready' : 'new'
      const ct = await c.query(
        `insert into lp.contacts (company_id, email, email_norm, first_name, is_role_address, email_source, verification_status, status, verified_at, verified_by)
         values ($1, $2, $2, $3, $4, $5, $6, $7, case when $6 <> 'unverified' then now() - interval '2 days' end, case when $6 <> 'unverified' then 'millionverifier' end)
         returning id`,
        [id, email, k === 0 && owner ? owner.split(' ')[0] : null, email.startsWith('info@'), k === 0 ? 'website' : 'website', v, status],
      )
      if (v !== 'unverified') {
        await c.query(`insert into lp.verification_results (contact_id, email, provider, result, verdict, cost_usd, checked_at) values ($1, $2, 'precheck', 'mx_ok', 'pass', 0, now() - interval '2 days')`, [ct.rows[0].id, email])
        await c.query(`insert into lp.verification_results (contact_id, email, provider, result, verdict, cost_usd, checked_at) values ($1, $2, 'millionverifier', $3, $4, 0.0039, now() - interval '2 days')`,
          [ct.rows[0].id, email, v === 'valid' ? 'ok' : v === 'catch_all' ? 'catch_all' : v === 'invalid' ? 'invalid' : 'unknown', v])
      }
      if (k === 0 && ['in_campaign', 'contacted', 'replied', 'interested', 'meeting', 'won', 'lost'].includes(stage)) {
        const camp = CAMPAIGNS[i >= 56 ? 2 : i % 2]
        const sentDay = 10 + Math.floor(rnd() * 8)
        await c.query(`insert into lp.campaign_touches (company_id, contact_id, email, campaign_name, event_type, occurred_at, source, external_id) values ($1, $2, $3, $4, 'email_sent', now() - ($5 || ' days')::interval, 'instantly_webhook', $6)`,
          [id, ct.rows[0].id, email, camp, String(sentDay), `seed-sent-${i}`])
        if (['replied', 'interested', 'meeting', 'won', 'lost'].includes(stage)) {
          const [subj, text] = REPLIES[i % REPLIES.length]
          const hrs = 2 + Math.floor(rnd() * 70)
          await c.query(`insert into lp.campaign_touches (company_id, contact_id, email, campaign_name, event_type, occurred_at, source, external_id, payload) values ($1, $2, $3, $4, 'reply_received', now() - ($5 || ' hours')::interval, 'instantly_webhook', $6, $7)`,
            [id, ct.rows[0].id, email, camp, String(hrs), `seed-reply-${i}`, JSON.stringify({ reply_subject: subj, reply_text_snippet: text, lead_email: email, campaign_name: camp, unibox_url: 'https://app.instantly.ai/app/unibox' })])
          const label = { interested: 'lead_interested', meeting: 'lead_meeting_booked', won: 'lead_closed', lost: 'lead_not_interested' }[stage]
          if (label) await c.query(`insert into lp.campaign_touches (company_id, contact_id, email, campaign_name, event_type, occurred_at, source, external_id) values ($1, $2, $3, $4, $5, now() - ($6 || ' hours')::interval + interval '1 hour', 'instantly_webhook', $7)`,
            [id, ct.rows[0].id, email, camp, label, String(hrs), `seed-label-${i}`])
        }
        if (stage === 'contacted' && i % 3 === 0) {
          await c.query(`insert into lp.campaign_touches (company_id, contact_id, email, campaign_name, event_type, occurred_at, source, external_id) values ($1, $2, $3, $4, 'auto_reply_received', now() - interval '20 hours', 'instantly_webhook', $5)`,
            [id, ct.rows[0].id, email, camp, `seed-ooo-${i}`])
        }
      }
    }
    if (owner) {
      await c.query(`insert into lp.enrichment (company_id, field, value, confidence, evidence_url, method, actor_id) values ($1, 'owner_name', $2, 'high', $3, 'regex', 'tab')`, [id, owner, `https://${domain}/about`])
      await c.query(`insert into lp.enrichment (company_id, field, value, confidence, evidence_url, method, actor_id) values ($1, 'pos', $2, 'medium', $3, 'regex', 'tab')`, [id, pick(['Square', 'Clover', 'Lightspeed', 'Shopify POS']), `https://${domain}`])
    }
  }
  // Bounces and unsubscribes on addresses that never became leads here.
  await c.query(`insert into lp.campaign_touches (email, campaign_name, event_type, occurred_at, source, external_id) values
    ('sales@closed-shop.example.com', 'Jewelers: card fees angle', 'email_bounced', now() - interval '30 hours', 'instantly_webhook', 'seed-b1'),
    ('owner@stopplease.example.com', 'Jewelers: same-day payouts', 'lead_unsubscribed', now() - interval '50 hours', 'instantly_webhook', 'seed-u1')`)

  // Tasks + activity so Overview has a team.
  const research = ids.filter((x) => x.stage === 'new').slice(0, 4)
  for (const [k, x] of research.entries()) {
    await c.query(`insert into lp.tasks (project_id, kind, title, status, claimed_by, company_id, heartbeat_at, lease_expires_at, created_by, dedupe_key)
      values ((select id from lp.projects where name = 'Lead research'), 'research_company', $1, $2, $3, $4, now(), now() + interval '10 minutes', 'owner', $5)`,
      [`Research ${x.name}`, k < 2 ? 'running' : 'queued', k < 2 ? (k === 0 ? 'tab' : 'hermes') : null, x.id, `research:${x.id}`])
  }
  await c.query(`insert into lp.approvals (action, summary, est_cost_usd, requested_by) values ('spend', 'Verify 48 emails with MillionVerifier (est. $0.19)', 0.19, 'tab')`)
  const ev = [
    ['system', 'import.sheet', 'Imported 40 leads from the Lead Master sheet (0 duplicates)'],
    ['tab', 'find.done', 'Find leads job #1 finished: 22 stores found in MD, VA and PA, 14 with an owner name'],
    ['tab', 'verify.run', 'Verification run #1: 30 checked, 24 valid, 3 catch-all, $0.12 spent'],
    ['hermes', 'task.claimed', `Hermes claimed "Research ${research[1]?.name ?? 'a store'}"`],
    ['tab', 'task.claimed', `Tab claimed "Research ${research[0]?.name ?? 'a store'}"`],
    ['owner', 'lead.comment', `Yaakov commented on ${ids[44].name}: @tab find the owner’s cell if it’s public`],
  ]
  for (const [k, [actor, kind, summary]] of ev.entries()) {
    await c.query(`insert into lp.events (at, actor, kind, summary) values (now() - ($1 || ' minutes')::interval, $2, $3, $4)`, [String((ev.length - k) * 17), actor, kind, summary])
  }
  await c.query(`insert into lp.comments (company_id, author, body, mentions) values ($1, 'owner', '@tab find the owner’s cell if it’s public', '{tab}')`, [ids[44].id])
  await c.query(`insert into lp.comments (company_id, author, body) values ($1, 'tab', 'Owner listed on the About page; no public cell. Shop line is on the contact page.')`, [ids[44].id])
  await c.query('commit')
  console.log(`seeded ${ids.length} synthetic leads into ${host}/${new URL(url).pathname.slice(1)}`)
} catch (e) {
  await c.query('rollback')
  throw e
} finally {
  c.release()
  await pool.end()
}
