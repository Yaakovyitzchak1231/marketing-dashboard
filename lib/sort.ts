/**
 * Ordering for a client-side table where some figures were never reported.
 *
 * The rule, and the reason it is not left to each call site: an ABSENT figure
 * is absent, not small and not large. It sinks below every reported value in
 * BOTH directions, so toggling the direction cannot promote "not reported" to
 * the top of the list.
 *
 * Substituting `-Infinity` for a missing value gets this wrong on the descending
 * pass, where the negation lifts every absent row to the front -- so a table of
 * mostly-unreported open rates reorders into "all the unknowns first" the moment
 * the direction is toggled. That is the open-rate bug ranked rather than
 * rendered.
 *
 * Rows with nothing to rank between them fall back to their name, which is
 * reproducible, rather than to whatever order the source happened to return.
 *
 * `Infinity` is returned as the COMPARATOR's answer -- the ordering signal
 * `Array#sort` consumes and immediately forgets. It is never read back out,
 * never ranked, and never printed.
 */
export type SortDirection = 'asc' | 'desc'

/** True when the value is a real number we can rank by. */
function isRankable(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Compare two rows by one numeric column, treating an absent value as absent.
 *
 * @param label reads the row's name, used only as the tie-break
 */
export function compareByMetric<T>(
  a: T,
  b: T,
  key: keyof T,
  direction: SortDirection,
  label: (row: T) => string,
): number {
  const aValue = a[key]
  const bValue = b[key]
  const aMissing = !isRankable(aValue)
  const bMissing = !isRankable(bValue)

  if (aMissing || bMissing) {
    if (aMissing && bMissing) return label(a).localeCompare(label(b))
    return aMissing ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY
  }

  const delta = (aValue as number) - (bValue as number)
  return direction === 'asc' ? delta : -delta
}

/** Compare two rows by name, reversed with the direction so the list flips whole. */
export function compareByName<T>(
  a: T,
  b: T,
  direction: SortDirection,
  label: (row: T) => string,
): number {
  return direction === 'asc'
    ? label(a).localeCompare(label(b))
    : label(b).localeCompare(label(a))
}
