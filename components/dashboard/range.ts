import type { RangeKey } from '@/lib/dashboard/types'

export const RANGES: RangeKey[] = ['7d', '14d', '30d', '90d', 'all']
export const DEFAULT_RANGE: RangeKey = '30d'

/** ?range= value -> a RangeKey. Anything unknown falls back to 30 days. */
export function parseRange(value: string | string[] | undefined): RangeKey {
  const v = Array.isArray(value) ? value[0] : value
  return RANGES.includes(v as RangeKey) ? (v as RangeKey) : DEFAULT_RANGE
}
