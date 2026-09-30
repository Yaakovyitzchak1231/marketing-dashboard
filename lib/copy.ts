export const COPY = {
  metricUnavailable: 'Not reported by Instantly',
  replyRateUnreliable: 'Reply rate is not reliable. Human replies exceed emails sent.',
  trendEmpty: 'Collecting history',
  staleDataOk: (lastCollectedAt: string) => `Collected ${lastCollectedAt}`,
  staleDataFailed: 'Last collection failed',
  loading: 'Loading',
  error: 'Something went wrong. Try again.',
  partialList: (visible: number, total: number) =>
    `Showing ${visible} of ${total} campaigns`,
} as const satisfies Record<string, string | ((...args: any[]) => string)>

export type CopyKey = keyof typeof COPY
