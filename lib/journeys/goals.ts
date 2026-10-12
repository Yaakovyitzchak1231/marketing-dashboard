/**
 * Journey goals — plan 3.16.
 *
 * The goal picker at journey (campaign) creation. Goals are stored on
 * lp.campaigns.goal as the human-readable label (so the existing free-text
 * goal UI keeps working); this module maps between keys and labels.
 */
export interface Goal {
  key: string
  label: string
  description: string
}

export const GOALS: Goal[] = [
  { key: 'book_meetings', label: 'Book meetings', description: 'Turn prospects into booked calls.' },
  { key: 'get_replies', label: 'Get replies', description: 'Start conversations, whatever they lead to.' },
  { key: 'reengage', label: 'Re-engage cold leads', description: 'Win back leads that went quiet.' },
  { key: 'nurture', label: 'Nurture relationships', description: 'Stay warm with useful follow-ups.' },
]

const BY_KEY = new Map(GOALS.map((g) => [g.key, g]))
const BY_LABEL = new Map(GOALS.map((g) => [g.label.toLowerCase(), g]))

/** Display label for a stored goal (key, label, or legacy free text). */
export function goalLabel(goal: string | null | undefined): string | null {
  if (!goal) return null
  const g = BY_KEY.get(goal) ?? BY_LABEL.get(goal.toLowerCase())
  return g ? g.label : goal
}

/** The goal key for a label or key, or null when it is custom free text. */
export function goalKey(goal: string | null | undefined): string | null {
  if (!goal) return null
  const g = BY_KEY.get(goal) ?? BY_LABEL.get(goal.toLowerCase())
  return g ? g.key : null
}

export function isGoalKey(v: string | null | undefined): boolean {
  return v != null && BY_KEY.has(v)
}
