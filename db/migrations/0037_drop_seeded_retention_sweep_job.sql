-- 0037: remove the seeded 'retention_sweep' job (Phase 2 review, Viktor on #88).
--
-- 0027 seeded a disabled lp.jobs row (name/kind 'retention_sweep', created_by
-- 'system'). Since #88 the retention sweep deletes nothing unless an OWNER
-- confirms that run (retention_sweep op with confirm: true, after reviewing
-- retention_preview), and the runner ('system') is refused. So a scheduled job
-- can never succeed; it would only fail every time it ran. The owner runs each
-- sweep from Settings -> Retention instead.
--
-- Add-only: 0027 is not edited. Its job_runs rows (if any) go with it
-- (lp.job_runs.job_name references lp.jobs on delete cascade). Safe to re-run.

delete from lp.jobs
 where name = 'retention_sweep'
   and kind = 'retention_sweep'
   and created_by = 'system';
