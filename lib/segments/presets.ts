/**
 * Starter segment templates (plan 2.3): campaign-agnostic, so the same list
 * works "for every campaign" Yaakov runs. Each preset is a plain
 * SegmentDefinition (the exact shape lib/segments/definition.ts validates) --
 * "Start from a template" (app/actions/segments.ts createFromPresetAction)
 * just calls createSegment with it, so the result is a normal, fully
 * editable segment (is_preset true; preset_key left NULL so a template can
 * be used any number of times -- see presetSegmentInput).
 *
 * Hot-by-score is only offered when a score field is actually registered in
 * the field registry (lead scoring, plan 2.8, lands in a parallel PR) -- it
 * is looked up by convention (any registered field whose key or label
 * mentions "score") rather than a hard-coded key, so this file never has to
 * change when that PR merges; until then this preset is simply omitted.
 */
import type { SegmentDefinition, SegmentEntity } from './definition.ts'
import { allFields } from './fields.ts'

export interface SegmentPreset {
  key: string
  label: string
  description: string
  group: 'Starter' | 'RFM'
  definition: SegmentDefinition
}

const STARTER_PRESETS: SegmentPreset[] = [
  {
    key: 'engaged',
    label: 'Engaged',
    description: 'Opened or clicked at least once, never replied.',
    group: 'Starter',
    definition: {
      entity: 'contact',
      include: [
        { conditions: [{ kind: 'event', event_type: 'email_opened', count_op: 'gte', count: 1 }] },
        { conditions: [{ kind: 'event', event_type: 'email_link_clicked', count_op: 'gte', count: 1 }] },
      ],
      exclude: [{ conditions: [{ kind: 'event', event_type: 'reply_received', count_op: 'gte', count: 1 }] }],
    },
  },
  {
    key: 'replied_positive',
    label: 'Replied-positive',
    description: 'Marked interested after replying.',
    group: 'Starter',
    definition: {
      entity: 'contact',
      include: [{ conditions: [{ kind: 'event', event_type: 'lead_interested', count_op: 'gte', count: 1 }] }],
      exclude: [],
    },
  },
  {
    key: 'gone_quiet',
    label: 'Gone quiet',
    description: 'Was emailed, but no open, click or reply in the last 45 days.',
    group: 'Starter',
    definition: {
      entity: 'contact',
      include: [{ conditions: [{ kind: 'event', event_type: 'email_sent', count_op: 'gte', count: 1 }] }],
      exclude: [
        { conditions: [{ kind: 'event', event_type: 'email_opened', count_op: 'gte', count: 1, within_last_days: 45 }] },
        { conditions: [{ kind: 'event', event_type: 'email_link_clicked', count_op: 'gte', count: 1, within_last_days: 45 }] },
        { conditions: [{ kind: 'event', event_type: 'reply_received', count_op: 'gte', count: 1, within_last_days: 45 }] },
      ],
    },
  },
  {
    key: 'never_opened_after_3',
    label: 'Never opened after 3 steps',
    description: 'Sent at least 3 emails, never opened one.',
    group: 'Starter',
    definition: {
      entity: 'contact',
      include: [{ conditions: [{ kind: 'event', event_type: 'email_sent', count_op: 'gte', count: 3 }] }],
      exclude: [{ conditions: [{ kind: 'event', event_type: 'email_opened', count_op: 'gte', count: 1 }] }],
    },
  },
  {
    key: 'bounced',
    label: 'Bounced',
    description: 'At least one bounced send.',
    group: 'Starter',
    definition: {
      entity: 'contact',
      include: [{ conditions: [{ kind: 'event', event_type: 'email_bounced', count_op: 'gte', count: 1 }] }],
      exclude: [],
    },
  },
  {
    key: 'ready_never_contacted',
    label: 'Ready but never contacted',
    description: 'Stage is ready, not in any campaign yet.',
    group: 'Starter',
    definition: {
      entity: 'company',
      include: [{ conditions: [{ kind: 'field', field: 'company.stage', op: 'is', value: 'ready' }, { kind: 'campaign_membership', mode: 'never_contacted' }] }],
      exclude: [],
    },
  },
  {
    key: 'owner_known_verified',
    label: 'Owner known + verified',
    description: 'Owner name on file, and has a verified sendable email.',
    group: 'Starter',
    definition: {
      entity: 'company',
      include: [{ conditions: [{ kind: 'field', field: 'company.owner_name', op: 'exists' }, { kind: 'quality', op: 'verified_sendable' }] }],
      exclude: [],
    },
  },
  {
    key: 'champions',
    label: 'Champions',
    description: 'Replied and booked a meeting.',
    group: 'RFM',
    definition: {
      entity: 'contact',
      include: [{ conditions: [{ kind: 'event', event_type: 'reply_received', count_op: 'gte', count: 1 }, { kind: 'event', event_type: 'meeting_booked', count_op: 'gte', count: 1 }] }],
      exclude: [],
    },
  },
  {
    key: 'at_risk',
    label: 'At risk',
    description: 'Engaged before, but silent for the last 30 days.',
    group: 'RFM',
    definition: {
      entity: 'contact',
      include: [
        { conditions: [{ kind: 'event', event_type: 'email_opened', count_op: 'gte', count: 1 }] },
        { conditions: [{ kind: 'event', event_type: 'email_link_clicked', count_op: 'gte', count: 1 }] },
        { conditions: [{ kind: 'event', event_type: 'reply_received', count_op: 'gte', count: 1 }] },
      ],
      exclude: [
        { conditions: [{ kind: 'event', event_type: 'email_opened', count_op: 'gte', count: 1, within_last_days: 30 }] },
        { conditions: [{ kind: 'event', event_type: 'email_link_clicked', count_op: 'gte', count: 1, within_last_days: 30 }] },
        { conditions: [{ kind: 'event', event_type: 'reply_received', count_op: 'gte', count: 1, within_last_days: 30 }] },
      ],
    },
  },
]

/** Any registered field that looks like a score column, by convention (key or label
 *  mentioning "score") -- lead scoring (2.8) registers its own field in a parallel PR;
 *  this file never needs to change once it does. */
function scoreField(): { key: string; table: SegmentEntity } | null {
  const f = allFields().find((fd) => /score/i.test(fd.key) || /score/i.test(fd.label))
  return f ? { key: f.key, table: f.table } : null
}

/** The full preset list available right now -- "Hot by score" only appears once a
 *  score field is registered (gracefully omitted until lead scoring, 2.8, lands). */
export function listPresets(): SegmentPreset[] {
  const presets = [...STARTER_PRESETS]
  const score = scoreField()
  if (score) {
    presets.push({
      key: 'hot_by_score',
      label: 'Hot by score',
      description: 'Score is 50 or higher.',
      group: 'RFM',
      definition: {
        entity: score.table,
        include: [{ conditions: [{ kind: 'field', field: score.key, op: 'gte', value: 50 }] }],
        exclude: [],
      },
    })
  }
  return presets
}

/**
 * The createSegment input for "Start from a template" (review fix, #80).
 * A user's copy is marked is_preset (the "template" pill) but leaves
 * preset_key NULL: migration 0024's segments_preset_key_uq index allows only
 * ONE live row per preset_key, so stamping the key on every copy made the
 * second use of the same template (for any campaign) fail with 23505.
 */
export function presetSegmentInput(preset: SegmentPreset, campaignId: number | null) {
  return {
    name: preset.label,
    description: preset.description,
    entity: preset.definition.entity,
    definition: preset.definition,
    campaign_id: campaignId,
    is_preset: true,
    preset_key: null,
  }
}

export function getPreset(key: string): SegmentPreset | null {
  return listPresets().find((p) => p.key === key) ?? null
}
