/**
 * Pure helpers for the dashboard's experiments form (components/campaign-steps/
 * ExperimentsPanel.tsx), kept out of the component so they are unit-testable.
 * No server imports: the client bundle uses this file.
 */
import { VARIANT_KEY_PATTERN, type VariantConfig } from './types.ts'

/**
 * Parse the "key:weight, key:weight" text field. Each entry must be exactly
 * key:weight with a valid variant key (VARIANT_KEY_PATTERN) and a positive
 * weight; the first problem is returned as plain text. The server validates the
 * same rules again (parseExperimentConfig); this only avoids a pointless request.
 */
export function parseVariantInput(text: string): { variants: VariantConfig[]; error: string | null } {
  const entries = text.split(',').map((p) => p.trim()).filter(Boolean)
  const variants: VariantConfig[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    const parts = entry.split(':').map((x) => x.trim())
    if (parts.length !== 2) {
      return { variants: [], error: `"${entry}": write each variant as key:weight, e.g. A:50.` }
    }
    const [key, w] = parts
    if (!VARIANT_KEY_PATTERN.test(key)) {
      return { variants: [], error: `"${key}" is not a valid variant key: use 1-32 letters, digits, _ or - (no spaces or colons).` }
    }
    const weight = Number(w)
    if (w === '' || !Number.isFinite(weight) || weight <= 0) {
      return { variants: [], error: `Variant ${key}: the weight must be a number above 0.` }
    }
    if (seen.has(key.toLowerCase())) return { variants: [], error: `Variant ${key} is listed twice.` }
    seen.add(key.toLowerCase())
    variants.push({ key, weight })
  }
  if (variants.length < 2) return { variants: [], error: 'Give at least two variants, e.g. A:50, B:50.' }
  return { variants, error: null }
}

export interface OutcomeForm { variant: string; sends: string; replies: string }

/**
 * The outcome form's state for an experiment: what the person typed, or the
 * defaults. The default variant is the FIRST CONFIGURED variant (what the
 * select shows), never a hard-coded 'A', so what is submitted is always what
 * is displayed. '' when the experiment has no variants.
 */
export function outcomeFormFor(
  state: Record<number, OutcomeForm | undefined>,
  experiment: { id: number; config: { variants: { key: string }[] } },
): OutcomeForm {
  return state[experiment.id] ?? { variant: experiment.config.variants[0]?.key ?? '', sends: '', replies: '' }
}
