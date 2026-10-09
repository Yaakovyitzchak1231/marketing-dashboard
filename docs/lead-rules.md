# Lead rules: requirements + personalization fields per pool and campaign

Migration `0010_campaign_rules.sql`. Screens: **Lead rules** (`/rules`, `/rules/:id`), the lead page's
"Ready for campaigns" box, the Overview's Ready tile, and the Add to Instantly preview.

## How it decides

- Every lead (company) is scored by one evaluator (`lib/rules/evaluate.ts`) under a rule set:
  **Ready-personalized** (every required personalization field has a real value), **Ready-generic**
  (Ready, but a required field is missing, or it's a role inbox), or **Parked** with every failed rule listed.
- Which rules: a campaign's own set if it has one, else its pool's (`lp.campaign_meta.segment`), else the default.
  Pools: jewelers, AI agencies, AI builders, other. A campaign created later uses its pool's rules immediately.
- Standing rules (code, always on): has an email; not do-not-contact; not on hold (needs-check waits for a person;
  role-based-hold waits until **owner research is marked exhausted**, then goes out Ready-generic in its own
  **role-inbox** batch with no-name copy, tagged `tab_batch=role-inbox`); email verified and not invalid
  (MillionVerifier → ZeroBounce order unchanged); not rejected; not already in a campaign.
  The evaluator never changes a contact's status. Held leads are never rejected.
- Only Ready leads can be added to Instantly. The preview uses the evaluator, and confirm re-checks under the
  rules as they are at that moment (leads that stopped qualifying are left out and listed).
- Freshness: `lp.enrichment.last_checked_at` is when a fact was last confirmed (re-found by research or import
  bumps it). "max age N days" on a rule or field reads it (email status reads `verified_at`).

## Requirements and fields

Requirement: `{ id, label?, enabled, field, op, value?, min_confidence?, max_age_days? }`
- `field`: `contact.verification_status`, `contact.status`, `contact.email`, `contact.is_role_address`,
  `contact.first_name` (confidence = name_confidence), `contact.last_name`, `contact.title`, `contact.phone`,
  `contact.personalization`, `company.name|segment|vertical|website_domain|phone|city|state|owner_name|stage|research_status`,
  or `enrichment:<fact key>` (e.g. `enrichment:business_type`; has confidence and last-checked date).
- `op`: present, absent, eq, neq, in, not_in, contains, is_true, is_false.
- Example: `{ field: 'enrichment:business_type', op: 'eq', value: 'independent jeweler', max_age_days: 365 }`.

Personalization field: `{ id, name, source, required, fallback?, min_confidence?, max_age_days?, enabled }`.
`name` becomes the Instantly custom variable `{{name}}`. A fallback is sent when there is no real value but never
makes a lead Ready-personalized.

## API (humans: login session; actor = owner)

| Method | Path | Body / result |
|---|---|---|
| GET | `/api/rules` | all rule sets with counts and re-score status, standing rules, field catalog, pending proposals |
| POST | `/api/rules` | `{scope: 'campaign'\|'template', from_id, campaign_id?, campaign_name?, segment?, name?}` → 201 |
| GET | `/api/rules/:id` | one set + counts, re-score status, top park reasons, proposals |
| PUT | `/api/rules/:id` | `{name, requirements, fields, base_version?}` → `{rule_set, changes}`; 400 invalid, 409 stale version |
| DELETE | `/api/rules/:id` | remove a campaign's own rules (back to its pool's) or a template |
| POST | `/api/rules/:id/recompute` | queue a full re-score → 202 |
| POST | `/api/rules/proposals/:approvalId` | `{decision: 'apply'\|'reject', note?}` |
| POST | `/api/leads/:id/owner-research` | `{exhausted: true\|false, note?}` |

Every change writes an activity-log row (`rules.updated`, `rules.created`, `rules.removed`,
`lead.owner_research_exhausted|reopened`) with the actor and old → new.

## Agents (OPS token, `/api/ops`)

Read: `list_rule_sets` (GET `/api/ops/rules`), `get_rule_set` (GET `/api/ops/rules/:id`, or `{campaign_id}`),
`lead_readiness` (GET `/api/ops/leads/:id/readiness`). Run a re-score pass: `rules_recompute`.
Change: **not allowed** (the database refuses a rule change not made by a human). `propose_rule_change`
(POST `/api/ops/rules/:id/propose`, same body as PUT + `note`) puts it in Needs your OK; a person applies it
on `/rules/:id`. `mark_owner_research_exhausted` (POST `/api/ops/leads/:id/owner-research-exhausted`) is allowed:
it sends nothing; adding to Instantly still takes a human.

## Re-scoring

Saving queues a re-score of that set: batches of 500 leads by id, each its own short transaction, resumable.
Lead changes mark stored scores stale (triggers) and new leads are scored on the next pass. Passes run in the
background after a save and when the Overview or Rules page is opened (`after()`, 20 s budget per pass).
The lead page and Add to Instantly always score live, so they never wait on a pass.
