# T3 — Schema + API: what I built and why it differs from the card

## The answer to `@leaddesk`'s question 1: neither (a) nor (b)

The card asked me to add `replies_human` + `replies_autoresponder` to `accounts`
(option a) or stop rating off `accounts` and aggregate `daily_metrics` (option b).

**Neither.** Option (a) is not implementable against this API, so I did not ship a
column that would be filled with a fiction.

### Why (a) is impossible: the two counters are not a partition

From `INSTANTLY_GET_CAMPAIGN_ANALYTICS`, account `instantly_moline-parsec`:

| campaign | sent | `reply_count` | `reply_count_unique` | `reply_count_automatic_unique` |
|---|---|---|---|---|
| IRS Penalty Back | 2 | 17 | 9 | 0 |
| PB Signups / Leads (TEST) | 3 | 12 | 10 | 0 |
| PB Signups / Leads | 31,893 | 1,696 | 1,357 | 8 |
| PB Wet Signature Needed | 464 | 137 | 116 | 1 |
| PB Qualified | 1,324 | 289 | 241 | 0 |
| PenaltyBack ERTC Funding | 9,452 | 157 | 143 | 19 |
| PB Partners | 281 | 34 | 26 | 1 |
| **TapDash Jewelry Retailers** | 2,126 | **8** | **8** | **10** |

On TapDash, `reply_count_automatic_unique` (10) **exceeds**
`reply_count_unique` (8). So the automatic count is not a subset of the unique
count — they are independent counters over different populations.

`human = unique − automatic` therefore evaluates to **−2**. A negative "human
reply count" passes every rate check in this repo, because −2 / 2,126 is a
valid-looking percentage. Any `replies_human` column would be a number I cannot
source.

`daily_metrics` in migration 001 had exactly this shape
(`replies_total`, `replies_human`, `replies_autoresponder`). It was never
populated, so nothing looked broken — it would have looked fine right up to the
first production write. **Migration 002 removes it.**

### Why (b) is not the right fix either

Aggregating `daily_metrics` would fix the missing split, but it introduces a
different lie: the two sources disagree whenever any campaign fails to collect.
QA measured 5 surviving rows summing to 33,686 sent against an overview total of
45,545 — a 26% understatement that would render as *the* headline number.

So `/api/overview` rates from `accounts` (the overview endpoint's own counters,
verbatim) and **returns the discrepancy instead of resolving it**:
`campaigns_inventory_count`, `campaigns_collected_count` and `partial`. When
those disagree the UI shows a partial-data banner. Per AGENTS.md, the mismatch
is the signal.

## The rate rule, in one place

`lib/rates.ts` — every route computes rates through `rateFrom`, so the number,
the trust flag and the reason string cannot drift apart between endpoints.

| condition | rate | `rate_trusted` | `rate_untrusted_reason` |
|---|---|---|---|
| numerator ≤ denominator, denominator > 0 | computed | `true` | `null` |
| **numerator > denominator** | `null` | `false` | `numerator_exceeds_denominator` |
| numerator or denominator null | `null` | `false` | `not_collected` |
| denominator = 0 | `null` | `false` | `no_sends` |
| row from a partial/failed collection | `null` | `false` | collector error stage, or `collector_error` |

A genuine 0 numerator over a positive denominator returns **0**, not null.
A null denominator returns null, not 0. Those are different claims.

### On the >100% ceiling

I tested all four candidate denominators against both broken campaigns before
writing the rule, because @build-qa proposed substituting the denominator:

| campaign | unique | sent | contacted | new_leads | leads_count |
|---|---|---|---|---|---|
| IRS Penalty Back | 9 | 2 | 2 | 2 | 4 |
| PB Signups (TEST) | 10 | 3 | 3 | 2 | 2 |

`leads_count` is the only field larger than `emails_sent_count`, and 9 > 4
anyway. **No denominator in the payload makes 450% or 333% go away.** I also
re-queried both with an explicit `start_date`/`end_date` window in case this was
a windowing artifact — identical numbers.

The rate is therefore suppressed with a stored reason rather than clamped to
100%. Clamping would be a claim; suppressing is a fact about what the API said.

**Live effect: 2 of 8 campaigns ship `reply_rate: null`.** Those rows render
@build-copy's *Not reported by Instantly* with `reply_rate_reason` available for
the label. The account rate (1,910 / 45,545 = 4.19%) is valid and ships as a
number.

`denominator_source` is a stored column, not a constant in the UI, so the
threshold choice is traceable. `MIN_SENDS_FOR_TRUST = 1` — no valid campaign in
this portfolio is excluded by it; the smallest real denominator is 281 (PB
Partners), which ships as 9.25%.

## Bug 3: open rate and unsubscribe

`open_count_unique` and `open_count_unique_by_step` are **0** in the overview
payload and 0 on all 8 campaigns. `unsubscribed_count` is likewise 0.

That 0 is a metric Instantly never measured. The API returns `null` because the
route reads `open_reported` / `unsub_reported`, which the collector sets FALSE.
Nullable columns alone would not have saved this — the collector was writing a
computed 0, so the fix had to go in the Python. **That work is T4's, not mine**,
and it is the single highest-risk remaining item: until T4 writes
`open_reported = false`, nothing upstream can distinguish "reported zero" from
"not reported". Flagging it rather than assuming it gets done.

Never widened to `if (!opensUnique) return null`: a genuine reported 0 would then
be suppressed too. The signal is the flag.

## What the schema now stores

- `daily_metrics` and `accounts`: `replies_unique`, `replies_automatic_unique`,
  `replies_all` as three independent nullable counts. No derived human column.
- `opens_unique` / `unsubscribed`: nullable, **no DEFAULT**, with a `*_reported`
  flag beside each.
- `rate_trusted` + `rate_untrusted_reason` + `denominator_source` on both tables,
  enforced by `CHECK (rate_trusted = TRUE OR rate_untrusted_reason IS NOT NULL)`
  so a bad insert fails in the database rather than on screen.
- `partial` and the collector error stage, so @build-copy's partial-data banner
  reads the collector's own failure list — never a guess.
- `campaigns_inventory_count` vs `campaigns_collected_count`, because
  `len(campaigns)` is the count of rows that *survived*, which is how the
  headline showed 5 for an 8-campaign account.
- `collection_errors` and `senders` tables for the T4 write path.

RLS: anon key reads, no browser write path. The collector holds `service_role`.
If a browser ever needs to write, that policy is the line that moves first.

## Verification

- `npx tsc --noEmit` → clean.
- `npx vitest run` → **35 passed**, including the 450% and 333% campaigns, the
  TapDash `8 − 10` case, and reported-vs-placeholder zero for opens.
- Static column check: every column the three routes read exists in migration
  002. This caught a real bug — the campaigns route read `open_reported` from
  `daily_metrics`, which migration 002 did not define. That would have been a
  runtime 500 on the main table, and it is fixed.

**Not verified: the migration has never been executed.** No Postgres server is
reachable on this host (`pg_isready` → no response; `initdb`/`pg_ctl` absent,
only the client `psql` is installed) and `supabase start` fails because Docker is
unavailable. I parsed the SQL with sqlglot and checked the `CHECK` constraint's
three-valued logic by hand, which is weaker evidence than running it. **@build-qa
should apply this migration against a real Supabase instance before T9 passes.**

Two of my own test bugs surfaced and were fixed rather than papered over: a
wrong expected value (1357/31893 rounds to 0.0425, not 0.0426) and a helper that
passed campaign-level fields into `daily_metrics`, making one assertion
meaningless.

## Handoff

- **@build-qa** — the migration is unexecuted. Apply it, then confirm the
  `CHECK` constraint rejects `rate_trusted = true` with a null reason.
- **@build-ui** — read `*_trusted` and `*_reason`, never the bare rate. Nulls
  sort last in both directions already. `partial` + both campaign counts drive
  the banner.
- **@build-copy** — your `rate_trusted` flag is in the API response next to the
  number, so the words cannot disagree with it. Reasons you'll see on live data:
  `numerator_exceeds_denominator` (2 campaigns), `not_collected`, `no_sends`,
  `collector_error`.
- **@leaddesk** — you asked me to pick (a) or (b) and say which. I picked
  neither, because (a) requires a subtraction that goes negative on live data.
  If you want a displayed human-reply rate, the decision is which fiction to
  accept, and I'd rather you make it than make it silently in a column.
