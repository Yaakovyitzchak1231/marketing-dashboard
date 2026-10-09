# Campaigns workspace

A campaign is a first-class object in the lead database (migration `0011_campaigns.sql`). You can start one,
give it a pool and rules, build its lead list and work it from the dashboard or the ops API, whether or not it
ever reaches Instantly. Nothing in the workspace calls Instantly.

## Screens

- `/campaigns`: every campaign (filter by pool, show archived), templates, **New campaign** (blank, a copy of a
  campaign, or from a template, with or without its leads), the status list (add / turn off statuses; it is a
  table, not code), Archive.
- `/campaigns/[id]`: settings (name, pool, status, owner, rules, goal, notes, template), Ready / Parked counts,
  the lead list with each lead's status and the reasons, filters (search, state, status), **Add leads** by
  filter (pool, stage, email status, verification, state, tag, search; it counts first, then adds) or by id,
  **Remove selected**, and per-lead **Edit**: personalization overrides (`firstName = Dana`, one per line),
  which contact to send to, tags, note. **Email steps** links to `/campaigns/[id]/steps` (the steps PR).
- `/campaigns/performance`: the Instantly numbers page that used to be `/campaigns`. Old `/campaigns?range=…`
  links redirect there.

## Rules and status

Each lead's status comes from the rules evaluator (PR #48, migration 0010): Ready-personalized, Ready-generic
or Parked with the rules that failed. A campaign uses `lp.campaigns.rule_set_id` if set (its own rules, or a
template / pool set picked for it), otherwise its pool's rules, otherwise the default.
`lib/campaigns/evaluator.ts` is the only file that knows about the evaluator.

Standing rules, enforced here:
- The workspace never changes a lead's or a contact's status. Removing a lead from a campaign only takes it off
  that list (the removed row, overrides included, is kept in the activity log). Role-based-hold and needs-check
  leads are never rejected or deleted.
- Only Ready leads ever upload, and only through Add to Instantly with a person's OK. MillionVerifier →
  ZeroBounce is untouched.
- Agents may not change a campaign's pool or rules (403); they can propose a rules change through Needs your OK.
  A campaign's own rule set is never shared: Duplicate copies it (a person's copy) or falls back to the pool's.

## API (agents, `Authorization: Bearer <OPS token>`)

`GET /api/ops` lists every op. Campaign ops:

| REST | op | body / query |
|---|---|---|
| `GET /api/ops/campaigns` | `list_campaigns` | `include_archived, pool, status, templates_only` |
| `POST /api/ops/campaigns` | `create_campaign` | `{name, pool?, goal?, notes?, owner?, status?, is_template?}` |
| `GET /api/ops/campaigns/:id` | `get_campaign` | the campaign + Ready/Parked counts |
| `POST /api/ops/campaigns/:id/update` | `update_campaign` | any of `name, goal, notes, owner, status, is_template` (pool / rules: people only) |
| `POST /api/ops/campaigns/:id/duplicate` | `duplicate_campaign` | `{name?, with_leads?, as_template?}` |
| `POST /api/ops/campaigns/:id/archive` | `archive_campaign` | |
| `GET /api/ops/campaigns/statuses` / `POST` | `list_campaign_statuses` / `add_campaign_status` | `{id, label, is_archived?}` |
| `GET /api/ops/campaigns/:id/leads` | `list_campaign_leads` | `q, state, tier (ready_personalized, ready_generic, parked, not_scored), page` |
| `POST /api/ops/campaigns/:id/leads` | `add_campaign_leads` | `{company_ids: [..]}` or `{filter: {pool, stage, contact_status, verification, state, tag, q}, preview?: true}` |
| `POST /api/ops/campaigns/:id/leads/remove` | `remove_campaign_leads` | `{company_ids: [..]}` |
| `GET|POST /api/ops/campaigns/:id/leads/:companyId` | `get_campaign_lead` / `update_campaign_lead` | `{overrides?, overrides_merge?, contact_id?, note?, tags?}` |

Every change writes one activity event (`campaign.created`, `campaign.updated` with `data.changes [{field, from,
to}]`, `campaign.duplicated`, `campaign.archived`, `campaign.leads_added`, `campaign.leads_removed`,
`campaign.lead_updated`, `campaign.status_added`) naming the actor.

## Wiring to the rules PR (#48)

This branch includes #48 (merge #48 first). `lib/campaigns/evaluator-live.ts` scores the leads on a page live with
#48's `evaluateCompanies` and makes a campaign's own rules with #48's `createRuleSet` (people only). Counts and the
status filter read #48's stored scores (`lp.lead_evaluations`), kept fresh by its background re-score. If live
scoring fails, the page shows the stored scores; a lead with no score says "Not scored yet", never a guess.
