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

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS status_reason TEXT,
    ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS status_changed_by UUID REFERENCES users (user_id) ON DELETE SET NULL;

-- Partial index — only admins querying "who did I recently suspend/ban" need
-- this, and it should stay cheap since most users are 'active' with a NULL
-- status_changed_at forever.
CREATE INDEX IF NOT EXISTS idx_users_status_changed_at ON users (status_changed_at DESC)
WHERE
    status_changed_at IS NOT NULL
    AND deleted_at IS NULL;
