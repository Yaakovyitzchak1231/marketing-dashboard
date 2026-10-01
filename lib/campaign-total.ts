/**
 * How many campaigns are there, and can we prove it?
 *
 * The campaign list is capped at `CAMPAIGN_ROW_LIMIT` rows so one response
 * cannot grow without bound. A cap is only honest if the reader can tell when
 * it bound, because a short list that looks complete is the silent-truncation
 * bug this dashboard exists to fix (AGENTS.md, bug #1).
 *
 * Disclosing that needs a count of campaigns matching the window, and the count
 * PostgREST hands back is not self-describing: it arrives as the right-hand
 * side of a `Content-Range` header, and a reader cannot tell from the header
 * whether it counted CAMPAIGNS or the joined `daily_metrics` rows behind them.
 * `daily_metrics` is a many-to-one child (`campaign_id` FK, one row per
 * campaign per day), so over a multi-day window a campaign contributes several
 * rows and an inflated count is not a small error -- it is a multiple.
 *
 * This module refuses to publish a count whose unit has not been established.
 * See `verifyCampaignTotal` for the reasoning. What the reader is told when a
 * count is unavailable is the cap's job, in components/campaign-table.tsx.
 */

/** How many campaigns one response may carry. A row cap, not a window. */
export const CAMPAIGN_ROW_LIMIT = 100

/**
 * Publish `windowed` as a count of campaigns, or `null` if its unit is not
 * established.
 *
 * Two independent measurements are cross-checked:
 *
 *   - `windowed`   -- PostgREST's count for the windowed, embedded select. The
 *                     suspect number. Its unit is inferred, not stated.
 *   - `portfolio`  -- the count of the `campaigns` table alone, with no embed
 *                     and no filter. Its unit is unambiguous by construction.
 *
 * A campaign count can never exceed the portfolio count, because the window is
 * a subset of the portfolio. So `windowed > portfolio` is a proof that
 * `windowed` is measuring something else -- almost certainly joined
 * `daily_metrics` rows -- and it is discarded rather than printed. Over any
 * multi-day window that is the overwhelmingly likely failure, and the check
 * catches it decisively.
 *
 * The check is a falsification, not a proof: a joined-row count that happened
 * to land exactly on the portfolio total would pass. That requires the window
 * to cover essentially every campaign with about one metric row each, and in
 * that shape the two counts coincide, so the published figure is right anyway.
 * The residue is a number that is wrong by a negligible amount in a
 * configuration that has to be contrived, rather than a multiple of the truth in
 * the configuration that actually occurs.
 *
 * `loaded` is the number of rows actually returned. A count below it is not a
 * count of the population those rows came from, so it is discarded too.
 *
 * Every rejection returns `null`, which means "the source did not say". The
 * caller then falls back to the cap, which is evidence by construction.
 */
export function verifyCampaignTotal(
  windowed: number | null,
  portfolio: number | null,
  loaded: number,
): number | null {
  if (windowed === null || portfolio === null) return null
  // supabase-js derives `count` with `parseInt(contentRange[1])`, so a
  // `Content-Range: */*` header yields NaN, which is not nullish. The same
  // `Number.isFinite` guard lib/format.ts applies to everything it prints, for
  // the same reason. Deliberately not a falsy check: 0 campaigns in the window
  // is a measurement, and it must survive.
  if (!Number.isFinite(windowed) || !Number.isFinite(portfolio)) return null
  if (windowed > portfolio) return null
  if (windowed < loaded) return null
  return windowed
}
