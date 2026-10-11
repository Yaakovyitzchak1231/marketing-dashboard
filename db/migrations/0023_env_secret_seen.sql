-- Oct 11, 2026: when the dashboard first saw each env-backed secret.
--
-- A secret set in Vercel env (no row in lp.secrets) has no "set" date of its
-- own. Settings shows "first seen <date>" instead: the first time the
-- dashboard read that env var with its current value. Only a short one-way
-- fingerprint of the value is kept (16 hex chars of sha256), never the value
-- or any part of it beyond what Settings already shows (last 4). When the
-- value changes, the fingerprint changes and first_seen_at resets.
-- Add-only.

create table if not exists lp.env_secret_seen (
  env_name       text primary key check (env_name ~ '^[A-Z][A-Z0-9_]{0,79}$'),
  fingerprint    text not null check (fingerprint ~ '^[0-9a-f]{16}$'),
  first_seen_at  timestamptz not null default now()
);
