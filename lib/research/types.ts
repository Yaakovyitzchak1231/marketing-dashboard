/**
 * The research engine contract. Any runner -- the built-in free one, Tab,
 * Hermes, a Claude session -- produces a ResearchResult for one company, and
 * the server writes it (lib/research/apply.ts) the same way every time.
 *
 * A research job is an lp.tasks row with kind = 'research_company',
 * company_id set, dedupe_key = 'research:<company_id>', payload { website?, name, city, state }.
 */

export interface FoundEmail {
  email: string
  /** Page the address was read from. Required: no evidence, no row. */
  evidence_url: string
  /** 'mailto' | 'text' | 'obfuscated' | 'jsonld' | 'llm' | 'agent' */
  how: string
  first_name?: string | null
  last_name?: string | null
  title?: string | null
  /**
   * true = an address built from a pattern (e.g. the store's published
   * sarah@ applied to the owner's name), not read anywhere. Saved with
   * status 'guessed-hold', email_source 'guessed', medium confidence; never
   * sendable until verification says otherwise. evidence_url is the page the
   * pattern was learned from.
   */
  guessed?: boolean
}

export interface FoundPerson {
  name: string
  role: string | null // 'owner', 'founder', 'president', 'manager', ...
  evidence_url: string
  confidence: 'high' | 'medium' | 'low'
  how: string
}

export interface ResearchResult {
  company_id: number
  /** Runner name: 'regex', 'llm', 'tab', 'hermes', ... */
  runner: string
  pages_fetched: { url: string; status: number | null; error?: string }[]
  emails: FoundEmail[]
  people: FoundPerson[]
  phones: { phone: string; evidence_url: string }[]
  /** Other facts: pos/tech/personalization etc. field -> value with evidence. */
  facts: { field: string; value: string; evidence_url: string | null; confidence: 'high' | 'medium' | 'low' }[]
  /** Plain-English one-liner for the activity feed. */
  summary: string
}

export interface ResearchTarget {
  company_id: number
  name: string
  website: string | null
  city: string | null
  state: string | null
}

export interface ResearchRunner {
  name: string
  run(target: ResearchTarget): Promise<ResearchResult>
}
