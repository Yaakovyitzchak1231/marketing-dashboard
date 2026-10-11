# Migration provenance — project zlbxjdueuhinywnovyoe

Measured 2026-10-11T19:34Z by `execute_sql` on the native Supabase MCP
(`https://mcp.supabase.com/mcp`, project `zlbxjdueuhinywnovyoe`). Not Composio.
No DDL was applied. No row was inserted into `supabase_migrations.schema_migrations`.
The catalog below is both the before reading and the after reading: nothing
was changed. A second `execute_sql` of the same catalog and of the row counts,
after this note was written, matched the first (2026-10-11T19:35Z). Row counts
are owner counts, not the authenticated-user path.

Files compared are `origin/main` at `5aa2ca7d`. This branch is `wt/t_119f03ee`
at `0a5a7d2` plus this note. `004` and `005` on that commit contain no
`ADD COLUMN` and no `CREATE TABLE`. They do `ENABLE ROW LEVEL SECURITY` and
`CREATE`/`DROP POLICY`. Re-applying `004` is not a no-op: it drops every
policy on `collection_runs` (including the live `jacob reads collection_runs`)
and then `CREATE POLICY` for `ideas_delete` / `costs_delete` / `angles_delete`
with no `DROP POLICY IF EXISTS`, so a re-run errors if those policies exist.
Supervisor decision on this card: do not re-apply. That decision is correct
on the measured catalog, and it is why this file exists instead of a migration.

## schema_migrations (3 rows)

```
001              initial_schema
20260930033250   add_collection_runs
20261006023519   checkpoints_per_artifact
```

`20261006023519` has `created_by = yytrout18@gmail.com`, one statement,
1312 characters. That statement enables RLS, drops policies, and creates
`checkpoints_authenticated_read`. It contains `test@example.com`. It does
not contain `yaakovytroutai@gmail.com`. It does not create a policy named
`authenticated_read`.

`origin/main` also has `004_security_hardening.sql`,
`005_rls_pre_existing_tables.sql`, `006_revision_history.sql`,
`008_collaboration_store.sql`, and `009_checkpoints_per_artifact.sql`.
None of those version strings are in `schema_migrations`. There is no `007`.

## relrowsecurity, every public table

Query:

```sql
select c.relname, c.relrowsecurity, c.relforcerowsecurity
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;
```

All 17 tables: `relrowsecurity = true`, `relforcerowsecurity = false`.

```
accounts, angle_daily_metrics, angles, approvals, campaigns, channels,
checkpoints, collection_runs, comments, costs, daily_metrics, domains,
ideas, inboxes, leads, revisions, verification_runs
```

Nothing has RLS off. `004`/`005` have no RLS toggle left to apply.

## Policies per table

Same 17 tables, policy counts from `pg_policies` joined to `pg_class`.
No table has RLS on and zero policies.

```
accounts 1
angle_daily_metrics 1
angles 4
approvals 3
campaigns 1
channels 1
checkpoints 4
collection_runs 1
comments 2
costs 4
daily_metrics 1
domains 1
ideas 4
inboxes 1
leads 1
revisions 3
verification_runs 1
```

34 policies. Names and commands that `004`/`005` require are live, scoped
to `yaakovytroutai@gmail.com`, role `authenticated`:

```
campaigns        jacob reads campaigns        SELECT   auth.email()
daily_metrics    jacob reads daily_metrics    SELECT   auth.email() via campaigns
accounts         jacob reads accounts         SELECT   auth.email()
collection_runs  jacob reads collection_runs  SELECT   auth.email()
ideas/costs/angles  *_insert *_update *_delete   jwt email claim
ideas/costs/angles  authenticated_read           SELECT auth.email()
```

`collection_runs` does not have `004`'s intermediate `authenticated_read`.
That is what `005` says the end state is. `ideas_write` / `costs_write` /
`angles_write` are absent, which is what `004` drops. No disagreement with
the intent of `004`/`005`. No policy was invented to make that true.

## What is live and not recorded as those filenames

Reported, not reconciled.

1. `004`, `005`, `006`, and `008` are absent from `schema_migrations`.
   Their effects are in the catalog: RLS on, the named policies above,
   `revisions` / `approvals` / `comments` present, audit columns
   `revision_id`, `revision_number`, `change_kind`, `change_message`,
   `actor` present on `ideas`, `costs`, and `angles`. Live
   `revisions` / `approvals` / `comments` policies use
   `auth.jwt() ->> 'email'` and `yaakovytroutai@gmail.com`, which is the
   form and email in `006` and `008`.
   `005` already records that the four collector policies were applied
   out of band on 2026-09-30 from an uncommitted `002_enable_rls.sql`.
   `006` and `008` are later than that date. Do not collapse them into
   2026-09-30.

2. `009` is not simply absent. `20261006023519` / `checkpoints_per_artifact`
   recorded a statement that adds `artifact_type`, `artifact_id`,
   `revision_number`, and `snapshot` on `checkpoints` and creates
   `checkpoints_authenticated_read`, `checkpoints_insert`, and
   `checkpoints_update`. Those columns exist. The live policies of those
   three names match the recorded statement, not the file on `origin/main`.
   Live `USING` / `WITH CHECK` is `test@example.com`. The committed file
   `009_checkpoints_per_artifact.sql` says `yaakovytroutai@gmail.com`.
   Re-applying the file would drop and recreate those three policies and
   change who they admit. That was not done.

3. `checkpoints` also has `authenticated_read` (`SELECT`, `authenticated`,
   `auth.jwt() ->> 'email' = yaakovytroutai@gmail.com`). Neither `009` nor
   the recorded statement creates that policy. It is an extra live policy.
   Left in place.

4. `revisions.snapshot` (`jsonb`) exists live. No migration on `origin/main`
   adds it. `009` adds `snapshot` to `checkpoints` only. Not backfilled
   into a migration here.

## Row counts

Owner `count(*)`, read before this note and again after it. Unchanged,
because no DDL ran.

```
campaigns 8
daily_metrics 24
accounts 3
collection_runs 492
revisions 3
approvals 4
comments 0
checkpoints 0
ideas 3
costs 0
angles 0
```

`comments` and `checkpoints` at 0 are measurements, not missing fields.
