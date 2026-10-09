# Lead rules evaluator — public interface (PR 1, branch `tab/campaign-rules`, migration 0010)

Stable contract for the campaigns workspace (0011) and email steps (0012) workers.
If anything here changes, this file changes in the same commit.

## Modules (all relative-import safe; `.ts` extensions inside lib/rules)

| Module | What |
|---|---|
| `lib/rules/schema.ts` | rule/field shapes, field catalog, validation (`parseRuleDoc`) |
| `lib/rules/evaluate.ts` | THE evaluator, pure (no DB) |
| `lib/rules/standing.ts` | standing rules (code, not editable) |
| `lib/rules/load.ts` | load the facts the evaluator needs |
| `lib/rules/store.ts` | rule sets in the DB: read, resolve per campaign, create/save (human only), agent proposals |
| `lib/rules/recompute.ts` | stored verdicts: batch re-score, stale refresh, counts |
| `lib/rules/readiness.ts` | Overview + lead-page helpers |
| `lib/rules/owner-research.ts` | "owner research exhausted" flag (releases role-based-hold to role-inbox batches) |
| `lib/rules/kick.ts` | `kickRecompute(db)` — background pass via `after()` (Next only, `server-only`) |

## Types (lib/rules/evaluate.ts, lib/rules/schema.ts)

```ts
type Tier = 'ready_personalized' | 'ready_generic' | 'parked'
type Batch = 'standard' | 'role-inbox'   // role inboxes go only in their own batches, no-name copy
const isReady: (t: Tier) => boolean     // true for both Ready tiers

interface ParkReason { rule: string; label: string; detail: string; standing: boolean }
//   rule = requirement id (e.g. 'r-email-valid') or standing code
//   ('no_email'|'do_not_contact'|'on_hold'|'invalid'|'not_verified'|'rejected'|'already_in_campaign')

interface ContactVerdict { contact_id: number; tier: Tier; batch: Batch; reasons: ParkReason[]; merge: Record<string,string>; missing: string[] }
interface LeadVerdict {
  company_id: number
  contact_id: number | null          // best contact (personalized > generic > parked, then valid email, then named inbox, then oldest)
  tier: Tier
  batch: Batch
  reasons: ParkReason[]              // ALL failed rules for the best contact (empty when Ready)
  merge: Record<string, string>      // personalization values {name: value}; fallback used when no real value
  missing: string[]                  // required field names with no real value (why it's generic)
  contacts: ContactVerdict[]         // every contact's verdict
  rule_set_id: number
  version: number
}

interface Requirement { id: string; label?: string|null; enabled: boolean; field: string; op: RuleOp;
  value?: string | string[] | null; min_confidence?: 'low'|'medium'|'high'|null; max_age_days?: number|null }
type RuleOp = 'present'|'absent'|'eq'|'neq'|'in'|'not_in'|'contains'|'is_true'|'is_false'
interface PersonalizationField { id: string; name: string /* Instantly {{name}} */; source: string; required: boolean;
  fallback?: string|null; min_confidence?: ...; max_age_days?: number|null; enabled: boolean }
interface RuleDoc { name: string; requirements: Requirement[]; fields: PersonalizationField[] }
interface RuleSetLike { id: number; version: number; requirements: Requirement[]; fields: PersonalizationField[] }
// field / source keys: FIELD_CATALOG keys (contact.*, company.*) or 'enrichment:<fact key>'
```

## Functions

```ts
// evaluate.ts (pure)
evaluateLead(lead: LeadFacts, rs: RuleSetLike, now?: Date): LeadVerdict
evaluateContact(lead: LeadFacts, ct: ContactFacts, rs: RuleSetLike, now: Date): ContactVerdict

// load.ts
loadLeadFacts(q: Queryable, companyIds: number[]): Promise<Map<number, LeadFacts>>

// recompute.ts
evaluateCompanies(q: Queryable, rs: RuleSetLike, companyIds: number[], now?: Date): Promise<LeadVerdict[]>   // load + evaluate, no write
storeVerdicts(q: Queryable, rs: RuleSetLike, verdicts: LeadVerdict[]): Promise<void>                      // upsert lp.lead_evaluations
queueRecompute(q: Queryable, ruleSetId: number, version: number, actor: string|null): Promise<void>
runRecompute(db: Db, opts?: { budgetMs?: number; batch?: number }): Promise<{ batches; leads; more }>
tierCounts(q): Promise<Map<ruleSetId, {ready_personalized, ready_generic, parked, stale, scored}>>

// store.ts
effectiveRuleSet(q: Queryable, opts: { ruleSetId?: number|null; campaignKey?: string|null; segment?: string|null }): Promise<RuleSetRow>
   // ruleSetId (if set and not archived) > set with campaign_id = campaignKey > pool (segment ?? campaign_meta.segment) > default
   // Dashboard campaigns (0011): effectiveRuleSet(q, { ruleSetId: campaign.rule_set_id, segment: campaign.pool })
ruleSetForCampaign(q: Queryable, instantlyCampaignId: string | null, segmentHint?: string | null): Promise<RuleSetRow>
   // Instantly campaigns: own set (campaign_id = id) > pool (campaign_meta.segment ?? segmentHint) > default
getRuleSet(q, id): Promise<RuleSetRow | null>;  listRuleSets(q): Promise<RuleSetRow[]>
createRuleSet(db, humanActor, { scope: 'campaign'|'template', from_id?, campaign_id?, campaign_name?, segment?, name? }): Promise<RuleSetRow>
   // scope 'campaign' with NO campaign_id = a set owned by a dashboard campaign (store its id in lp.campaigns.rule_set_id).
   // No from_id: copies the pool's set for `segment` (else the default). Templates need from_id.
saveRuleSet(db, humanActor, id, doc: RuleDoc, { base_version? }): Promise<{ ruleSet, changes }>  // logs old->new, queues re-score
archiveRuleSet(db, humanActor, id)
proposeRuleChange(db, agentActor, { rule_set_id, name, requirements, fields, note? })        // -> Needs your OK
// Only humans write rule sets (DB trigger + requireHuman). Agents propose.

// owner-research.ts
setOwnerResearchExhausted(db, actor, companyId, exhausted: boolean, note: string|null)
```

## Tables (migration 0010)

- `lp.rule_sets(id, name, scope 'default'|'pool'|'campaign'|'template', segment, campaign_id text, campaign_name,
   requirements jsonb[], fields jsonb[], version int, based_on, archived, created_by, updated_by, created_at, updated_at)`
   - one `default`, one `pool` per segment (jeweler, ai_agency, ai_builder, other), one non-archived `campaign` set per campaign_id.
- `lp.lead_evaluations(rule_set_id, company_id) PK, contact_id, tier, batch, reasons jsonb, merge jsonb, missing jsonb, version, stale, evaluated_at`
   - marked `stale` by triggers on lp.companies / lp.contacts / lp.enrichment.
- `lp.rule_recompute(rule_set_id PK, version, status queued|running|done|failed, cursor, processed, total, ...)`
- `lp.enrichment.last_checked_at` (+ `last_checked_by`) — freshness rules read this.
- `lp.companies.owner_research_exhausted_at / _by / owner_research_note`.
- `segment` checks now include `ai_builder` (companies, campaign_meta).

## How a campaign points at a rule set

Two kinds of campaign, one resolver (`effectiveRuleSet`):

- **Dashboard campaigns (lp.campaigns, 0011, BIGINT id):** point at their own set through
  `lp.campaigns.rule_set_id` (nullable). Effective set = `campaigns.rule_set_id` ?? the pool set for `campaigns.pool`
  ?? the default → `effectiveRuleSet(q, { ruleSetId: c.rule_set_id, segment: c.pool })`.
  To give one its own rules: `createRuleSet(db, human, { scope: 'campaign', segment: c.pool, campaign_name: c.name, from_id? })`
  (no campaign_id), then store the returned id in `lp.campaigns.rule_set_id`.
- **Instantly campaigns:** `lp.rule_sets.campaign_id` = the Instantly campaign id (TEXT, optional column);
  pool from `lp.campaign_meta.segment` → `ruleSetForCampaign(q, instantlyId)`.
- No own set → the pool's rules apply automatically, including for campaigns created later.

## Keys for personalization

Personalization values, per-lead overrides and `{{placeholders}}` key on the field **name**
(`PersonalizationField.name`, e.g. `firstName`), never on the field id. `LeadVerdict.merge` is `{ [name]: value }`;
Instantly custom variables use the same names (plus `tab_batch: 'role-inbox'` on role-inbox batches).

## Standing rules (cannot be edited away)

no email · do-not-contact · on hold (needs-check always; role-based-hold until owner research exhausted, then
Ready-generic in role-inbox batches only) · invalid · not verified yet (MillionVerifier → ZeroBounce order untouched) ·
rejected · already in a campaign. Only Ready leads upload (Add to Instantly preview AND confirm re-check use the evaluator).
