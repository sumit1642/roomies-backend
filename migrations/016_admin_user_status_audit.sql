-- Migration 016: Admin user account-status audit columns
--
-- ADR-016 Phase 2 (PATCH /admin/users/:userId/status) requires the admin to
-- supply a reason when suspending/banning/deactivating a user. users.account_status
-- already existed (migration 001) but had nowhere to persist *why* or *who*
-- changed it or *when* — every prior write to this column happened via
-- direct SQL with no audit trail at all.
--
-- These three columns are intentionally minimal (not a separate history
-- table): ADR-016 explicitly scopes this as "no new audit-log DB table" —
-- meta.action / logger.info calls carry the append-only trail. These columns
-- only need to answer "what is the CURRENT reason for the CURRENT status",
-- which a full history table would be overkill for at single-admin scale.
--
-- FK added NOT VALID: ADD CONSTRAINT ... FOREIGN KEY without NOT VALID takes
-- an ACCESS EXCLUSIVE lock on `users` for the duration of a full scan
-- validating every existing row against the referenced table — on a live
-- `users` table this blocks all reads/writes for the scan's duration. NOT
-- VALID skips that scan (new rows are still checked going forward) and lets
-- validation happen separately, out of this transaction, via migration 016b.
--
-- The index that originally lived in this file (idx_users_status_changed_at)
-- has been split out to 016c_idx_users_status_changed_at.concurrent.sql —
-- CREATE INDEX (non-CONCURRENTLY) inside migrate.js's BEGIN/COMMIT wrapper
-- takes the same kind of table-wide lock; CONCURRENTLY avoids it but cannot
-- run inside a transaction block, hence the separate .concurrent.sql file
-- (see migrations/001b's header comment for the established pattern).

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS status_reason TEXT,
    ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS status_changed_by UUID;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'users_status_changed_by_fkey'
    ) THEN
        ALTER TABLE users
            ADD CONSTRAINT users_status_changed_by_fkey
                FOREIGN KEY (status_changed_by) REFERENCES users (user_id) ON DELETE SET NULL
                NOT VALID;
    END IF;
END;
$$;
