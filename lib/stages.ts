/**
 * Collector error stages and their human labels.
 *
 * The collector records what it was doing when an API call failed. Those stage
 * keys are snake_case and machine-shaped; @build-copy needs prose for the
 * partial-data banner. This map is the single shared source for that mapping
 * so the page never has to maintain a parallel dictionary that drifts.
 *
 * Keyed by stage prefix because `campaign:8ddf6580` names a specific campaign
 * while the prefix names the stage. Two known stages from the live collector
 * (`collect_instantly.py`) are `overview`, `list_campaigns`, `senders`, and
 * `campaign:<id8>`.
 *
 * `labelForStage` is total: an unrecognised stage returns a neutral string and
 * is reported by `isKnownStage`. That matters more than it looks -- the failure
 * mode of a partial map is exactly the one @build-copy asked me to prevent, an
 * unrecognised key printing itself into the UI as `list_campaigns`. Better a
 * visible "unexpected failure" than a snake_case key presented as a label.
 *
 * The labels themselves are @build-copy's to change. This file owns the
 * association, not the wording.
 */

export const STAGE_LABELS = {
  overview: 'Account overview',
  list_campaigns: 'Campaign inventory',
  senders: 'Sending accounts',
  campaign: 'Campaign analytics',
} as const

/** Stages the collector is known to emit, for exhaustiveness tests. */
export const KNOWN_STAGES = Object.keys(STAGE_LABELS) as Array<keyof typeof STAGE_LABELS>

/**
 * The label used when the stage is not recognised. Deliberately generic: it
 * states that something failed without inventing which thing.
 */
export const UNKNOWN_STAGE_LABEL = 'Unexpected failure'

export interface StageLabel {
  /** Prose for a human. Never a raw stage key. */
  label: string
  /** The machine key this label came from. */
  stage: string
  /** For `campaign:<id8>`, the campaign id. null for account-wide stages. */
  campaignExternalId: string | null
  /** FALSE when the stage was not in the map above. */
  known: boolean
}

/**
 * Split a collector stage into its prefix and campaign id.
 * `campaign:8ddf6580` -> ['campaign', '8ddf6580']
 * `senders`          -> ['senders', null]
 */
export function splitStage(stage: string): { prefix: string; campaignExternalId: string | null } {
  const idx = stage.indexOf(':')
  if (idx === -1) return { prefix: stage, campaignExternalId: null }
  return { prefix: stage.slice(0, idx), campaignExternalId: stage.slice(idx + 1) }
}

export function isKnownStage(stage: string): boolean {
  return (KNOWN_STAGES as string[]).includes(splitStage(stage).prefix)
}

export function labelForStage(stage: string): StageLabel {
  const { prefix, campaignExternalId } = splitStage(stage)
  const known = (KNOWN_STAGES as string[]).includes(prefix)
  return {
    label: known ? STAGE_LABELS[prefix as keyof typeof STAGE_LABELS] : UNKNOWN_STAGE_LABEL,
    stage,
    campaignExternalId,
    known,
  }
}

/**
 * Group a collector error list into banner-ready form.
 *
 * The banner sentence is "{collected} of {inventory} campaigns collected", but
 * a human still needs to know *what* failed. This returns one entry per
 * distinct stage with a count, so `senders: malformed response` appears once
 * with "x3" rather than three times.
 *
 * @build-copy's banner needs only `partial` and the two counts. This is the
 * detail behind it, and it is derived from the collector's own error list --
 * never from a count the UI guesses.
 */
export interface StageGroup {
  label: string
  stage: string
  campaignExternalId: string | null
  count: number
  known: boolean
}

export function groupStages(errors: Array<{ stage: string }>): StageGroup[] {
  const buckets = new Map<string, StageGroup>()
  for (const e of errors) {
    const info = labelForStage(e.stage)
    const existing = buckets.get(info.stage)
    if (existing) {
      existing.count += 1
    } else {
      buckets.set(info.stage, {
        label: info.label,
        stage: info.stage,
        campaignExternalId: info.campaignExternalId,
        count: 1,
        known: info.known,
      })
    }
  }
  return [...buckets.values()].sort((a, b) => b.count - a.count)
}
