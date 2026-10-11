/**
 * Pure rule evaluation for lead scoring (plan 2.8). No DB access here: given a
 * score model's rules and a lead's recent lp.lead_events rows, say which rules
 * fire, how many points each awards, and when each award expires. engine.ts
 * does the DB work (reading events, writing lp.score_points, summing lp.scores);
 * this file is the part worth unit-testing without a database.
 */

export interface ScoreRule {
  rule_key: string
  label: string
  /** The lp.event_types key this rule listens for. */
  event_type: string
  points: number
  /** Points from this rule stop counting after this many days (null/undefined = never). */
  expires_after_days?: number | null
  /** Only fire when the event's props match every key given here (shallow equality). */
  props_match?: Record<string, unknown> | null
}

export interface ScoreThreshold {
  key: string
  label: string
  min: number
}

/** The slice of a lead_events row a rule needs to decide whether it fires. */
export interface ScorableEvent {
  id: number
  type: string
  occurred_at: Date | string
  props?: Record<string, unknown> | null
}

export interface RuleAward {
  rule_key: string
  points: number
  source_event_id: number
  awarded_at: Date
  expires_at: Date | null
}

function propsMatch(event: ScorableEvent, match: Record<string, unknown> | null | undefined): boolean {
  if (!match) return true
  const props = event.props ?? {}
  return Object.entries(match).every(([k, v]) => props[k] === v)
}

/** Parse rules jsonb (already an array from the DB) into typed, validated ScoreRule[]. Throws on malformed input. */
export function parseRules(raw: unknown): ScoreRule[] {
  if (!Array.isArray(raw)) throw new Error('rules must be an array')
  return raw.map((r, i) => {
    if (!r || typeof r !== 'object') throw new Error(`rules[${i}] must be an object`)
    const o = r as Record<string, unknown>
    const rule_key = typeof o.rule_key === 'string' ? o.rule_key.trim() : ''
    const event_type = typeof o.event_type === 'string' ? o.event_type.trim() : ''
    const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : rule_key
    const points = Number(o.points)
    if (!rule_key) throw new Error(`rules[${i}].rule_key is required`)
    if (!event_type) throw new Error(`rules[${i}].event_type is required`)
    if (!Number.isFinite(points) || !Number.isInteger(points)) throw new Error(`rules[${i}].points must be an integer`)
    const expires = o.expires_after_days == null ? null : Number(o.expires_after_days)
    if (expires != null && (!Number.isFinite(expires) || expires <= 0)) throw new Error(`rules[${i}].expires_after_days must be a positive number`)
    const propsM = o.props_match && typeof o.props_match === 'object' && !Array.isArray(o.props_match) ? (o.props_match as Record<string, unknown>) : null
    return { rule_key, label, event_type, points, expires_after_days: expires, props_match: propsM }
  })
}

export function parseThresholds(raw: unknown): ScoreThreshold[] {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new Error('thresholds must be an array')
  return raw.map((t, i) => {
    if (!t || typeof t !== 'object') throw new Error(`thresholds[${i}] must be an object`)
    const o = t as Record<string, unknown>
    const key = typeof o.key === 'string' ? o.key.trim() : ''
    const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : key
    const min = Number(o.min)
    if (!key) throw new Error(`thresholds[${i}].key is required`)
    if (!Number.isFinite(min)) throw new Error(`thresholds[${i}].min must be a number`)
    return { key, label, min }
  })
}

/**
 * Which rules fire for a batch of events, and what each award looks like
 * (points + expiry). One event can fire at most one award per rule_key — a
 * rule is keyed to the event that earned it (engine.ts dedupes on
 * (model_id, rule_key, source_event_id) at insert time too, belt and suspenders).
 */
export function evaluateEvents(rules: ScoreRule[], events: ScorableEvent[]): RuleAward[] {
  const awards: RuleAward[] = []
  for (const event of events) {
    const occurredAt = new Date(event.occurred_at)
    for (const rule of rules) {
      if (rule.event_type !== event.type) continue
      if (!propsMatch(event, rule.props_match)) continue
      const expiresAt = rule.expires_after_days ? new Date(occurredAt.getTime() + rule.expires_after_days * 86400000) : null
      awards.push({ rule_key: rule.rule_key, points: rule.points, source_event_id: event.id, awarded_at: occurredAt, expires_at: expiresAt })
    }
  }
  return awards
}

/** A point award is "live" (still counts toward the score) at `now` when it has no expiry or hasn't expired yet. */
export function isLive(expiresAt: Date | string | null, now: Date = new Date()): boolean {
  if (!expiresAt) return true
  return new Date(expiresAt).getTime() > now.getTime()
}

/** Sum only the live points, optionally capped at max_points (a cap never makes a negative sum less negative). */
export function sumScore(points: { points: number; expires_at: Date | string | null }[], maxPoints: number | null, now: Date = new Date()): number {
  const total = points.filter((p) => isLive(p.expires_at, now)).reduce((acc, p) => acc + p.points, 0)
  if (maxPoints == null) return total
  return total > maxPoints ? maxPoints : total
}

/** Highest threshold a score crosses (thresholds sorted by min desc), or null if it crosses none. */
export function thresholdFor(score: number, thresholds: ScoreThreshold[]): ScoreThreshold | null {
  const sorted = [...thresholds].sort((a, b) => b.min - a.min)
  return sorted.find((t) => score >= t.min) ?? null
}

/**
 * Build a Fit model's rules from a campaign profile: each approved 'signal_rule'
 * profile item becomes one scoring rule (config.points / config.event_type on the
 * item, or sane defaults), and the profile's ICP contributes nothing scored here
 * directly (ICP gates lead *entry*, via lib/rules/evaluate.ts; signal rules are
 * what scores ongoing *fit*). Nothing industry-specific: every rule comes from
 * the campaign's own rows, never a hard-coded list.
 */
export function fitRulesFromProfile(items: { kind: string; name: string; value: string | null; config: Record<string, unknown>; status: string }[]): ScoreRule[] {
  return items
    .filter((i) => i.kind === 'signal_rule' && i.status === 'approved')
    .map((i, idx) => {
      const cfg = i.config ?? {}
      const eventType = typeof cfg.event_type === 'string' && cfg.event_type.trim() ? cfg.event_type.trim() : 'custom'
      const points = Number.isFinite(Number(cfg.points)) ? Math.trunc(Number(cfg.points)) : 5
      const expires = cfg.expires_after_days == null ? null : Number(cfg.expires_after_days)
      return {
        rule_key: `signal_${idx}_${i.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)}`,
        label: i.name,
        event_type: eventType,
        points,
        expires_after_days: Number.isFinite(expires) && expires! > 0 ? expires : null,
        props_match: eventType === 'custom' && typeof cfg.signal_type === 'string' ? { signal_type: cfg.signal_type } : null,
      } satisfies ScoreRule
    })
}
