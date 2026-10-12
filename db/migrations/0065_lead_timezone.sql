-- Plan 3.10: the lead's time zone, so quiet hours and send windows are local.
--
-- Send windows, quiet-hours clocks, launch_at and active_until live in
-- lp.journeys.settings (jsonb from 0057). This file only adds the column
-- those clocks need. Null means unknown; the resolver falls back. An invalid
-- name is not rejected here.
--
-- Add-only and idempotent: safe to run twice. No extensions.

alter table lp.companies add column if not exists timezone text;
alter table lp.contacts add column if not exists timezone text;
