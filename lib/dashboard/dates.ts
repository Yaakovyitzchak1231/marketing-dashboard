import { isSupportedRange, type Range } from '@/lib/range'

/**
 * Type guard for the range keys accepted by the dashboard route.
 * Delegates to the shared range validator so the API and the shell
 * cannot drift apart.
 */
export function isRangeKey(value: string): value is Range {
  return isSupportedRange(value)
}