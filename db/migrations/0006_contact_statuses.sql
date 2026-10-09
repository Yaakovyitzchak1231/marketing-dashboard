-- Lead Master statuses added in the Sheet after the move (Oct 7-8, 2026):
--   role-based-hold : a role address (info@, sales@...) held until an owner email is found
--   needs-check     : a human has to look at this lead before anything is sent
-- Same vocabulary as the Sheet, so a status sync never has to drop or rename one.
--
-- Lock-safe swap on a populated lp.contacts (the new list is a superset of the
-- old one, so every existing row already satisfies it): the replacement is
-- added NOT VALID (a catalog change only), then validated under a SHARE
-- UPDATE EXCLUSIVE lock, which lets reads and writes continue (only DDL and
-- VACUUM wait). Only then is the old constraint dropped and the new one
-- renamed into place. Dropping the old constraint first and re-adding it
-- would validate the whole table under an ACCESS EXCLUSIVE lock instead.
alter table lp.contacts add constraint contacts_status_check_new check (status in (
  'new', 'verifying', 'valid-ready', 'catch-all-hold', 'guessed-hold', 'role-based-hold', 'needs-check',
  'rejected', 'in-Instantly', 'sent', 'replied', 'bounced', 'do-not-contact')) not valid;
alter table lp.contacts validate constraint contacts_status_check_new;
alter table lp.contacts drop constraint if exists contacts_status_check;
alter table lp.contacts rename constraint contacts_status_check_new to contacts_status_check;
