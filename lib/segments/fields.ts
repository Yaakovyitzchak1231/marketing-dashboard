/**
 * The pluggable field registry every segment condition reads field metadata
 * from: a key the DSL may name, the SQL expression it compiles to (identifiers
 * only -- never a value), its type, and which operators make sense on it.
 *
 * This is the one seam custom fields (1.7: lp.field_defs, companies.custom /
 * contacts.custom jsonb), lead scoring (2.8) and computed traits (2.7) plug
 * into later: call `registerField` with a `sql` expression that reads the
 * jsonb column (e.g. "c.custom ->> 'ring_brand'") and it shows up in the
 * builder and compiler without lib/segments/compile.ts changing at all.
 * Aligns with lib/rules/schema.ts's field catalog where the same column is
 * meaningful in both ("Ready" rules and segments should agree).
 */

export type FieldType = 'text' | 'number' | 'boolean' | 'date' | 'array'
export type FieldEntityTable = 'company' | 'contact'

export interface FieldDef {
  /** Dotted key the DSL names, e.g. "company.state", "contact.verification_status". */
  key: string
  label: string
  /** Which base table this reads: which alias (c / ct) its `sql` uses. */
  table: FieldEntityTable
  type: FieldType
  /** A SQL expression using ONLY the fixed aliases c (lp.companies) / ct (lp.contacts).
   *  Never built from user input -- this is the one place identifiers come from. */
  sql: string
  /** Operators allowed on this field, narrowing OPS_BY_TYPE for this key specifically
   *  (e.g. a field with few distinct values might drop `contains`). Omit to allow
   *  every operator OPS_BY_TYPE lists for the type. */
  operators?: readonly string[]
}

const SQL_IDENTIFIER_RE = /^(c|ct)\.[a-z_][a-z0-9_]*$/

const registry = new Map<string, FieldDef>()

export class FieldRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FieldRegistryError'
  }
}

/** Register (or replace) a field. `sql` must be a bare "c.column" / "ct.column" identifier --
 *  enforced here so nothing downstream ever has to trust a caller's SQL text. */
export function registerField(def: FieldDef): void {
  if (!/^[a-z][a-z0-9_.]{0,63}$/.test(def.key)) throw new FieldRegistryError(`field key "${def.key}" must be a lowercase dotted slug`)
  if (!SQL_IDENTIFIER_RE.test(def.sql)) {
    throw new FieldRegistryError(`field "${def.key}": sql must be a bare "c.column" or "ct.column" identifier, got "${def.sql}"`)
  }
  const wantAlias = def.table === 'company' ? 'c.' : 'ct.'
  if (!def.sql.startsWith(wantAlias)) throw new FieldRegistryError(`field "${def.key}": table is "${def.table}" but sql is "${def.sql}"`)
  registry.set(def.key, def)
}

export function getField(key: string): FieldDef | undefined {
  return registry.get(key)
}

export function requireField(key: string): FieldDef {
  const f = registry.get(key)
  if (!f) throw new FieldRegistryError(`unknown field "${key}"`)
  return f
}

export function allFields(): FieldDef[] {
  return [...registry.values()].sort((a, b) => a.key.localeCompare(b.key))
}

// --------------------------------------------------------------------------
// Seed fields from the real schema (lp.companies, lp.contacts -- see
// db/migrations/0001_lead_platform.sql, 0011_campaigns.sql, 0019_suppressions.sql,
// 0020_campaign_profiles.sql). Geography is state/city only: the repo has no
// lat/lng on lp.companies yet, so radius search is deferred (see docs).
// --------------------------------------------------------------------------

registerField({ key: 'company.name', label: 'Company name', table: 'company', type: 'text', sql: 'c.name' })
registerField({ key: 'company.website_domain', label: 'Website domain', table: 'company', type: 'text', sql: 'c.website_domain' })
registerField({ key: 'company.state', label: 'State', table: 'company', type: 'text', sql: 'c.state' })
registerField({ key: 'company.city', label: 'City', table: 'company', type: 'text', sql: 'c.city' })
registerField({ key: 'company.country', label: 'Country', table: 'company', type: 'text', sql: 'c.country' })
registerField({ key: 'company.postal_code', label: 'Postal code', table: 'company', type: 'text', sql: 'c.postal_code' })
registerField({ key: 'company.owner_name', label: 'Owner name', table: 'company', type: 'text', sql: 'c.owner_name' })
registerField({
  key: 'company.stage',
  label: 'Stage',
  table: 'company',
  type: 'text',
  sql: 'c.stage',
  operators: ['is', 'is_not', 'in', 'not_in', 'exists', 'not_exists'],
})
registerField({
  key: 'company.research_status',
  label: 'Research status',
  table: 'company',
  type: 'text',
  sql: 'c.research_status',
  operators: ['is', 'is_not', 'in', 'not_in'],
})
// "pool" in the plan's words; the column is still named `segment` (migration 0020
// repointed it at lp.pools, a table, not a fixed list -- see lib/pools/store.ts).
registerField({
  key: 'company.pool',
  label: 'Pool',
  table: 'company',
  type: 'text',
  sql: 'c.segment',
  operators: ['is', 'is_not', 'in', 'not_in'],
})
registerField({ key: 'company.tags', label: 'Tags', table: 'company', type: 'array', sql: 'c.tags' })
registerField({ key: 'company.created_at', label: 'Company created', table: 'company', type: 'date', sql: 'c.created_at' })
registerField({ key: 'company.updated_at', label: 'Company last updated', table: 'company', type: 'date', sql: 'c.updated_at' })
registerField({ key: 'company.last_researched_at', label: 'Last researched', table: 'company', type: 'date', sql: 'c.last_researched_at' })

registerField({ key: 'contact.email', label: 'Email', table: 'contact', type: 'text', sql: 'ct.email_norm' })
registerField({ key: 'contact.first_name', label: 'First name', table: 'contact', type: 'text', sql: 'ct.first_name' })
registerField({ key: 'contact.last_name', label: 'Last name', table: 'contact', type: 'text', sql: 'ct.last_name' })
registerField({ key: 'contact.title', label: 'Title', table: 'contact', type: 'text', sql: 'ct.title' })
registerField({
  key: 'contact.status',
  label: 'Contact status',
  table: 'contact',
  type: 'text',
  sql: 'ct.status',
  operators: ['is', 'is_not', 'in', 'not_in'],
})
registerField({
  key: 'contact.verification_status',
  label: 'Verification status',
  table: 'contact',
  type: 'text',
  sql: 'ct.verification_status',
  operators: ['is', 'is_not', 'in', 'not_in'],
})
registerField({
  key: 'contact.subscription_status',
  label: 'Subscription status',
  table: 'contact',
  type: 'text',
  sql: 'ct.subscription_status',
  operators: ['is', 'is_not', 'in', 'not_in'],
})
registerField({ key: 'contact.do_not_contact', label: 'Do not contact', table: 'contact', type: 'boolean', sql: 'ct.do_not_contact' })
registerField({ key: 'contact.created_at', label: 'Contact created', table: 'contact', type: 'date', sql: 'ct.created_at' })
registerField({ key: 'contact.verified_at', label: 'Verified at', table: 'contact', type: 'date', sql: 'ct.verified_at' })
