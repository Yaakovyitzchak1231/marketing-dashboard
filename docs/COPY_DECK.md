# Copy Deck

Use these strings for the seven honest dashboard states listed in the copy task.
All copy is plain, direct, and specific. No hype. No invented numbers.

## 1. Metric unavailable

Use when a metric exists in the UI but is not reported by the Instantly API.

- `open_rate` label/placeholder: **Not reported by Instantly**
- `unsubscribe` label/placeholder: **Not reported by Instantly**

Why: the API does not populate these values. Showing `0.0%` implies a measurement. This copy says the API did not report one.

## 2. Rate that cannot be trusted

Use when reply rate exceeds `100%` or the backend flags it as unreliable.

- Inline suppression text: **Reply rate is not reliable. Human replies exceed emails sent.**

Why: the flag fires when human replies are greater than emails sent, which is not a possible rate. The displayed rate is `replies_human / emails_sent` — autoresponders are a separate column and are *not* in that count, so they must not be named as the cause. Checked against Supabase on 2026-09-30: the two flagged campaigns have 9 replies / 2 sent and 10 replies / 3 sent, with zero autoresponders on both.

## 3. Empty history / first run

Use when the trend chart has no stored rows yet.

- Trend empty state: **Collecting history**

Why: it tells the user the system is working, not that the chart is broken or blank.

## 4. Stale data

Use on the last-updated line near the top of the dashboard.

- Healthy: **Collected <timestamp>**
- Failed collection: **Last collection failed**

Why: show when data was last collected. If collection failed, say that plainly instead of showing old data as fresh.

## 5. Partial list

Use when the campaign list is truncated or otherwise incomplete.

- Example rendered string: **Showing 2 of 148 campaigns**

Pass the visible count and total count. Never render a silently short list without saying it is partial.

## 6. Loading

Use while a fetch is in flight.

- Loading state: **Loading**

## 7. Error

Use when a fetch fails.

- Error text: **Something went wrong. Try again.**

This gives one action without overpromising help text.
