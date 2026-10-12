-- Plan 3.3: a trigger that fires N days after event X unless event Y happened.
--
-- Builds on lp.triggers / lp.trigger_fires (3.2, merged). The journey runner
-- (3.1, PR #115) already enrols from trigger_fires, so this file does not
-- create journey tables and does not touch 0057-0060.
--
-- A pending row lives in lp.trigger_delays until it is due. Y cancels it.
-- When it is due and Y never arrived, one lp.trigger_fires row is written
-- and the runner enrols, with cancel_on in the payload.
--
-- House rule for timing windows: they use lp.lead_events.occurred_at (when the
-- thing happened), never recorded_at (when we stored it). source_at is the
-- source event's occurred_at; due_at = source_at + N days; Y cancels only when
-- its occurred_at is in [source_at, due_at].
--
-- The lp.triggers kind check below is the inline column check from 0053, which
-- Postgres names triggers_kind_check (<table>_<column>_check). The drop is
-- "if exists" only so a re-run is idempotent; the add is deliberately loud: if
-- any stored row has a kind outside the new list, this migration fails.

alter table lp.triggers drop constraint if exists triggers_kind_check;
alter table lp.triggers add constraint triggers_kind_check check (kind in (
  'event', 'segment_entry', 'segment_exit', 'field_change', 'date', 'schedule', 'api', 'delayed'
));

create table if not exists lp.trigger_delays (
  id               bigint generated always as identity primary key,
  trigger_id       bigint not null references lp.triggers(id) on delete cascade,
  company_id       bigint,
  contact_id       bigint,
  source_event_id  bigint,
  source_at        timestamptz,
  due_at           timestamptz not null,
  unless_events    text[] not null,
  status           text not null default 'pending' check (status in ('pending', 'fired', 'cancelled')),
  created_at       timestamptz not null default now()
);

-- Databases that ran an earlier draft of this file have the table without it.
alter table lp.trigger_delays add column if not exists source_at timestamptz;

create unique index if not exists trigger_delays_source_uq
  on lp.trigger_delays (trigger_id, source_event_id) where source_event_id is not null;
create index if not exists trigger_delays_due_idx
  on lp.trigger_delays (due_at) where status = 'pending';
