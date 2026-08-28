-- Migration 016b: Validate users_status_changed_by_fkey (added NOT VALID in 016)
--
-- VALIDATE CONSTRAINT still scans the table, but takes only a SHARE UPDATE
-- EXCLUSIVE lock (blocks other schema changes, NOT normal reads/writes) —
-- unlike the ACCESS EXCLUSIVE lock a non-NOT-VALID FK add would have held for
-- the same scan. Run as its own migration/transaction so its (short but
-- nonzero) scan time is isolated from 016's column-add and doesn't extend
-- that transaction's lock window.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'users_status_changed_by_fkey'
          AND NOT convalidated
    ) THEN
        ALTER TABLE users VALIDATE CONSTRAINT users_status_changed_by_fkey;
    END IF;
END;
$$;
