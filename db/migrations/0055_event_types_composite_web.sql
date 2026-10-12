-- 0055: new lead event types for composite rules and site tracking.
--
-- Add-only: inserts into lp.event_types (on conflict do nothing); no schema
-- change, no existing rows touched.
--
--   positive_reply  a composite_rule derivation: the lead replied AND was
--                   marked interested (or booked a meeting). Emitted by
--                   lib/events/composite.ts, never directly by a source.
--   page_visited    the site's tracking snippet saw a page load (source site).
--   form_submitted  the site's tracking snippet saw a form submit (source site).

insert into lp.event_types (key, label, category, source) values
  ('positive_reply', 'Positive reply', 'email', 'composite_rule'),
  ('page_visited',   'Page visited',   'web',   'site'),
  ('form_submitted', 'Form submitted', 'web',   'site')
on conflict (key) do nothing;
