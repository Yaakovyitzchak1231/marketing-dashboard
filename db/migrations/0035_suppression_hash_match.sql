-- Phase 2 review fix (#81, Viktor): "Forget this person" now turns plaintext
-- suppressions for the forgotten address into hashed ones (lp.suppressions.email_hash,
-- added by 0027) and deletes the plaintext rows. So the send-time check keeps blocking
-- that address, lp.is_suppressed also matches a live hashed row: sha256 hex of the
-- normalized (lower/trim) email, the same value lib/retention/store.ts emailHash() writes.
-- Add-only: replaces the function body, same signature; no table changes.
create or replace function lp.is_suppressed(p_email text, p_campaign_id bigint default null)
returns boolean language sql stable as $$
  select exists (
    select 1 from lp.suppressions s
     where s.lifted_at is null
       and (s.expires_at is null or s.expires_at > now())
       and (s.campaign_id is null or s.campaign_id = p_campaign_id)
       and (s.email_norm = lower(trim(p_email))
            or s.domain = lower(split_part(trim(p_email), '@', 2))
            or s.email_hash = encode(sha256(convert_to(lower(trim(p_email)), 'UTF8')), 'hex'))
  )
$$;
