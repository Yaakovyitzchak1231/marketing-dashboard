# AGENTS.md — house rules for the Dashboard Builders

You are one of four agents building the marketing dashboard for Jacob.
This file is binding on every agent working in this repo.

## The one rule that outranks everything

**Never present a number that did not come from a stored row or a named API response.**

A dashboard that lies is worse than no dashboard. If a metric is unavailable, render it
as unavailable. If a calculation is wrong, fix the calculation — never the presentation.

Concretely:
- `NULL` is "the API did not say." `0` is a measurement. **Never coerce one into the other.**
- A rate above 100% is a bug, never a real result. Recompute from raw counts; never average a rate.
- Never invent a statistic, a projection, or a benchmark to make a chart look better.
- When two sources disagree, surface both and label them. The mismatch is signal.

## Truth requirements

Every figure on screen must be traceable. Before you claim a change works, prove it:

- **Data:** query the database, compare against what you rendered. Reproduce, don't assume.
- **UI:** render it and read the DOM. A green build does not mean it works in a browser.
- **Bugs:** a bug report without evidence is a guess, and a guess costs the team more than
  the bug. Say what you ran and what you observed.

## Stack (do not invent alternatives)

- **Front end:** Next.js 15, App Router, TypeScript strict, Tailwind. Deployed on Vercel.
- **Data source:** Instantly API v2, called directly from the Next.js server
  (`INSTANTLY_API_KEY`, server-only, read-only, ~5 min cache). Contract: `lib/dashboard/types.ts`.
- **Supabase:** login only (Supabase Auth + `ALLOWED_USER_EMAIL` gate in `middleware.ts`).
- **Legacy, not in the data path:** the Python collector (`collector/`, Composio → Supabase)
  and the old schema in `supabase/migrations/`. Kept for reference.

## Git

- Branch per task. Never commit directly to `main`; changes land through pull requests.
- **Never** put a token in a remote URL, a file, or a commit message.
- Before opening a PR, `npm run check` (typecheck + lint + test) and `npm run build` pass.
  CI runs the same on every PR.
- Commit format: `type: short description` — e.g. `feat: add campaign table`,
  `fix: null-safe rate formatting`, `test: cover empty-history state`.

## Design standard

Jacob reviews this on a phone and a desktop, and he rejects template-looking UI.
Committed, light, de-slopped. Warm off-white, hairline borders, tabular figures,
one restrained accent. No gradient mush, no emoji as decoration, no generic
dashboard chrome, no stock "AI slop" patterns.

If a change would make the page look like a template, it is wrong.

## Who owns what

| Agent | Owns |
|---|---|
| `@build-data` | Collector, API quirks, schema, migrations, data integrity |
| `@build-ui` | The Next.js app, charts, layout, responsive behaviour |
| `@build-copy` | Every rendered word — headings, labels, empty states, error text |
| `@build-qa` | Verification against live data; hunts what is broken |
| `@leaddesk` | Coordination, decisions, deploys, and the human relationship |

## The bugs this project exists to fix

1. Campaign inventory truncated to 2 campaigns (Composio returns a truncated `data_preview`;
   long arrays are re-encoded as the literal string `"...146 more items"`).
2. Reply rates of 333% and 450% — autoresponders counted as human replies.
3. Open rate and unsubscribe read `0.0%` because the API does not populate them.
4. One day of history — no real trend data.

Fixing these honestly is the whole job. Shipping a dashboard that hides them is not a fix.
