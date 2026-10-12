/**
 * A/B experiments on journey (campaign) steps — plan 3.6.
 * One experiment per (campaign, step_number); leads are assigned to variants
 * deterministically and the winner can be picked automatically once the
 * variant stats clear the same 95% z-test the insights engine uses.
 */

export interface VariantConfig {
  /** Variant key, e.g. 'A'. Must be unique within the experiment. */
  key: string
  /** Traffic weight; shares are weight / total weight. */
  weight: number
}

export interface ExperimentConfig {
  variants: VariantConfig[]
  /** When true, evaluate_experiment may flip status to 'decided' on its own. */
  auto_winner: boolean
  /** Minimum sends per variant before a winner can be declared. */
  min_sends_per_variant: number
}

export type ExperimentStatus = 'draft' | 'running' | 'paused' | 'decided'

export interface Experiment {
  id: number
  campaign_id: number
  step_number: number
  name: string
  status: ExperimentStatus
  config: ExperimentConfig
  winner_variant: string | null
  decided_at: Date | null
  decided_by: string | null
  created_by: string | null
  created_at: Date
  updated_at: Date
}

export interface ExperimentOutcome {
  experiment_id: number
  variant: string
  sends: number
  replies: number
  updated_at: Date
}

export interface ExperimentDetail extends Experiment {
  outcomes: ExperimentOutcome[]
  assignments: number
}
