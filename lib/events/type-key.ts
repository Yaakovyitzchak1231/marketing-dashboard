/**
 * The shape of an event type key (lp.event_types.key): a lowercase slug that may
 * contain dots, like `reply_received` or `review.posted`. Mirrors the check
 * constraint in db/migrations/0018_lead_events.sql. No imports, so any module
 * (including the journey node registry) can use it.
 */
export const EVENT_TYPE_KEY_RE = /^[a-z][a-z0-9_.]{0,63}$/
