/**
 * The task kinds the dashboard itself creates or knows how to route, for the
 * "which kinds does this agent take" picker on /settings. Stored as plain
 * strings on lp.actors.takes_kinds; none selected means the agent takes any kind.
 */
export interface TaskKindOption {
  value: string
  label: string
  hint: string
}

export const TASK_KINDS: TaskKindOption[] = [
  { value: 'find_leads', label: 'Find leads', hint: 'Search for new companies to contact' },
  { value: 'research_company', label: 'Research a company', hint: 'Look up one company in depth' },
  { value: 'verify_contacts', label: 'Verify emails', hint: 'Check that contact emails are real' },
  { value: 'review_reply', label: 'Review replies', hint: 'Review a reply from a lead' },
  { value: 'send_batch', label: 'Send emails', hint: 'Send a batch of emails' },
  { value: 'seo_fix', label: 'SEO fixes', hint: 'Fix an SEO issue on a website' },
  { value: 'general', label: 'Other tasks', hint: 'Anything else from the board' },
]

/** The known kinds plus any extra kind an agent already has saved, so nothing saved is hidden. */
export function taskKindOptions(saved: string[] = []): TaskKindOption[] {
  const known = new Set(TASK_KINDS.map((k) => k.value))
  const extra = saved.filter((k) => !known.has(k)).map((k) => ({ value: k, label: k.replace(/_/g, ' '), hint: 'Saved earlier' }))
  return [...TASK_KINDS, ...extra]
}
