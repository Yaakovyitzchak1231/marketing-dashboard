/**
 * Every number the insights engine uses to decide what to say lives here, with
 * a name and a one-line reason. Nothing else in lib/insights may hard-code a
 * cut-off. Change a value here and every rule (and classifyAccountHealth, which
 * the sender-health table uses) moves with it.
 *
 * Where a value is a judgment call rather than a published figure, it says so.
 */

/* ---------- statistics ---------- */

/** z for a two-sided 95% interval / test. Standard statistics, not a tuning knob. */
export const CONFIDENCE_Z = 1.96

/* ---------- campaign ranking ---------- */

/**
 * A campaign must have contacted at least this many leads in the period before
 * it is ranked best/worst. Below it, a couple of replies swing the rate by
 * whole points, so we say "too early to judge" instead. Judgment call.
 */
export const MIN_CONTACTED_TO_RANK = 100

/**
 * A campaign that has contacted at least this many leads with zero human
 * replies is flagged. With 0 of 150 the 95% Wilson upper bound is ~2.5%, so
 * the true reply rate is very likely below a typical cold-email result.
 */
export const MIN_CONTACTED_FOR_ZERO_REPLY = 150

/* ---------- sequence steps and A/B variants ---------- */

/** Each variant needs this many sends before two variants are compared. Judgment call. */
export const MIN_SENDS_PER_VARIANT = 100

/**
 * A follow-up step (step 2+) needs this many sends with zero replies before we
 * suggest cutting or rewriting it. At 0 of 200 the 95% upper bound is ~1.9%.
 */
export const MIN_SENDS_TO_CUT_STEP = 200

/** A step/variant needs this many sends to compete for "best subject line". Judgment call. */
export const MIN_SENDS_FOR_SUBJECT = 100

/** Replies needed across all steps before we describe where in the sequence replies come from. */
export const MIN_REPLIES_FOR_STEP_MIX = 20

/** If step 1 earns at least this share of all replies, follow-ups are adding little. Judgment call. */
export const FIRST_STEP_DOMINANT_SHARE = 0.7

/** If follow-ups (step 2+) earn at least this share of replies, they are pulling real weight. Judgment call. */
export const FOLLOWUPS_STRONG_SHARE = 0.4

/* ---------- deliverability ---------- */

/**
 * Bounce rate (bounced / sent) above this is a warning. Widely used cold-email
 * guidance keeps hard bounces under 2% to protect sender reputation.
 */
export const BOUNCE_WARN = 0.02

/**
 * Bounce rate above this is critical: mailbox providers start throttling or
 * spam-foldering senders around here. Widely used cold-email guidance.
 */
export const BOUNCE_CRITICAL = 0.05

/** The whole workspace needs this many sends in the period before its bounce rate is judged. */
export const MIN_SENT_FOR_TOTAL_BOUNCE = 100

/** One sending account needs this many sends in the period before its bounce rate is judged. Judgment call. */
export const MIN_SENT_FOR_ACCOUNT_BOUNCE = 50

/** Instantly warmup score (0-100) below this puts an account on watch. Judgment call. */
export const WARMUP_WATCH = 90

/** Warmup score below this puts an account at risk. Judgment call. */
export const WARMUP_AT_RISK = 70

/**
 * An account sending at least this multiple of the median sending account is
 * carrying too much of the load. Needs MIN_ACCOUNTS_FOR_LOAD_CHECK accounts.
 * Judgment call.
 */
export const LOAD_MULTIPLE_OF_MEDIAN = 2

/** Minimum number of accounts that sent anything before load balance is checked. */
export const MIN_ACCOUNTS_FOR_LOAD_CHECK = 3

/** An overloaded account must also have sent at least this many emails, so 6 vs 2 never fires. */
export const MIN_SENT_FOR_LOAD_CHECK = 100

/* ---------- replies waiting on you ---------- */

/** An interested lead waiting at least this many days is a warning. Judgment call: reply same day. */
export const FOLLOWUP_WARN_DAYS = 1

/** An interested lead waiting at least this many days is critical: interest decays fast. Judgment call. */
export const FOLLOWUP_CRITICAL_DAYS = 3

/** Individual "reply to X" cards shown before the rest roll up into one card. */
export const MAX_LEAD_CARDS = 5

/* ---------- trends (this period vs the previous, same-length period) ---------- */

/** Each period needs this many leads contacted before reply/positive rates are compared. */
export const MIN_CONTACTED_FOR_TREND = 100

/** The previous period needs this many sends before a volume drop is judged. */
export const MIN_SENT_FOR_VOLUME_TREND = 200

/** Sending volume falling by at least this share vs the previous period is flagged. Judgment call. */
export const VOLUME_DROP_SHARE = 0.5

/**
 * This many consecutive finished days (today excluded) with zero sends, after
 * days that did send, means sending stalled. 3 so a normal weekend pause never fires.
 */
export const STALL_DAYS = 3

/** Days of leads left (at this period's pace) below which a campaign is about to run dry. Judgment call. */
export const LOW_RUNWAY_DAYS = 5
