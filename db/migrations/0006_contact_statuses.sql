-- Add new contact statuses and update the check constraint safely
-- Use NOT VALID + VALIDATE CONSTRAINT to avoid ACCESS EXCLUSIVE lock on populated lp.contacts

-- Add new constraint with updated status list (NOT VALID)
ALTER TABLE lp.contacts 
  ADD CONSTRAINT contacts_status_check_new 
  CHECK (status IN (
    'new',
    'verifying',
    'valid-ready',
    'catch-all-hold',
    'guessed-hold',
    'rejected',
    'in-Instantly',
    'sent',
    'replied',
    'bounced',
    'do-not-contact',
    'role-based-hold',
    'needs-check'
  )) NOT VALID;

-- Validate the new constraint (acquires SHARE lock, not ACCESS EXCLUSIVE)
ALTER TABLE lp.contacts VALIDATE CONSTRAINT contacts_status_check_new;

-- Drop the old constraint
ALTER TABLE lp.contacts DROP CONSTRAINT contacts_status_check;

-- Rename the new constraint to the original name
ALTER TABLE lp.contacts RENAME CONSTRAINT contacts_status_check_new TO contacts_status_check;
