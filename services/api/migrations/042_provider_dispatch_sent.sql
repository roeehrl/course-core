-- When the gateway passed its last fence for a dispatch and may have sent it to the provider.
-- Set in the same transaction as that fence check (which locks the enrollment), so a dispatch
-- that is `in_flight` with no `sent_at` has certainly not reached a provider, and once its job
-- has ended it never will. Data erasure releases such a reservation instead of charging it.
ALTER TABLE provider_dispatches ADD COLUMN sent_at timestamptz;
-- Earlier rows may have been sent: keep them conservative.
UPDATE provider_dispatches SET sent_at=started_at WHERE state IN ('in_flight','completed','uncertain');
