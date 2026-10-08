/** Line diff (LCS) for the before/after preview. Pure. */
export type DiffLine = { op: 'same' | 'del' | 'add'; text: string }

export function lineDiff(before: string | null, after: string | null): DiffLine[] {
  const a = (before ?? '').split('\n')
  const b = (after ?? '').split('\n')
  if (before == null || before === '') return b.map((text) => ({ op: 'add' as const, text }))
  if (after == null || after === '') return a.map((text) => ({ op: 'del' as const, text }))
  const n = a.length
  const m = b.length
  if (n * m > 400_000) return [...a.map((text) => ({ op: 'del' as const, text })), ...b.map((text) => ({ op: 'add' as const, text }))]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: 'same', text: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: 'del', text: a[i++] })
    else out.push({ op: 'add', text: b[j++] })
  }
  while (i < n) out.push({ op: 'del', text: a[i++] })
  while (j < m) out.push({ op: 'add', text: b[j++] })
  return out
}

/** Pretty-print JSON so a schema diff is line-by-line; anything else passes through. */
export function prettyMaybeJson(s: string | null): string | null {
  if (s == null) return null
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}
