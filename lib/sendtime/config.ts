/**
 * Send-time optimisation: every tunable in one place. Each is explained in
 * docs/SEND_TIME.md.
 */

/**
 * What counts as engagement, and how much. Replies and clicks only: opens
 * are excluded entirely (Apple Mail Privacy Protection and security scanners
 * fire opens at machine times, the Instantly webhook stores them as
 * low_trust, and an open follows OUR send hour, so learning from opens would
 * just reinforce whatever hour we already used). A reply is the strongest
 * signal a human read the mail, a click weaker (scanners click too).
 */
export const ENGAGEMENT_WEIGHTS: Readonly<Record<string, number>> = {
  reply_received: 3,
  email_link_clicked: 2,
}
export const ENGAGEMENT_TYPES: string[] = Object.keys(ENGAGEMENT_WEIGHTS)

/** Minimum engagement events before a window is trusted. */
export const MIN_SAMPLE = 8

/** Evidence older than this is not used, and a window whose newest evidence is older than this is treated as absent. */
export const WINDOW_MAX_AGE_DAYS = 180

/** The batch only revisits leads that engaged within this many days. */
export const DISCOVERY_DAYS = 90

/** Fallback timezone (ET) until a lead-specific one is known. */
export const DEFAULT_TIMEZONE = 'America/New_York'

/** Business hours, lead-local. Sends never leave this band; ties between equally good hours resolve toward its middle. */
export const QUIET_HOURS_START = 8
export const QUIET_HOURS_END = 18
export const BUSINESS_HOURS_MIDPOINT = (QUIET_HOURS_START + QUIET_HOURS_END) / 2

/** Never shift a send more than this far out from the due time. */
export const MAX_SHIFT_HOURS = 48

/** Day-of-week numbers (0 = Sunday) a best day may take: Monday to Friday. */
export const BUSINESS_DAYS: readonly number[] = [1, 2, 3, 4, 5]
