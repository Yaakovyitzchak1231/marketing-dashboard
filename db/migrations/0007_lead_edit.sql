-- Manual lead editing (the lead page's Edit buttons): a contact can carry its own
-- phone number (a person's direct line, not the store's), raw as typed plus E.164
-- like lp.companies. The held statuses a person can pick (role-based-hold,
-- needs-check) are already valid since 0006.
alter table lp.contacts add column if not exists phone text;
alter table lp.contacts add column if not exists phone_e164 text;
