-- Lead Master statuses added in the Sheet after the move (Oct 7-8, 2026):
--   role-based-hold : a role address (info@, sales@...) held until an owner email is found
--   needs-check     : a human has to look at this lead before anything is sent
-- Same vocabulary as the Sheet, so a status sync never has to drop or rename one.
alter table lp.contacts drop constraint if exists contacts_status_check;
alter table lp.contacts add constraint contacts_status_check check (status in (
  'new', 'verifying', 'valid-ready', 'catch-all-hold', 'guessed-hold', 'role-based-hold', 'needs-check',
  'rejected', 'in-Instantly', 'sent', 'replied', 'bounced', 'do-not-contact'));
