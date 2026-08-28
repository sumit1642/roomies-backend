-- Migration 016c: idx_users_status_changed_at, built CONCURRENTLY
--
-- Split out of migration 016 (originally a plain CREATE INDEX IF NOT EXISTS
-- inside migrate.js's transactional path). CREATE INDEX CONCURRENTLY cannot
-- run inside a transaction block, so this runs via migrate.js's
-- non-transactional (.concurrent.sql) path instead — same pattern as
-- 001b_idx_listings_city_lower_concurrent.concurrent.sql.
--
-- Partial index — only admins querying "who did I recently suspend/ban" need
-- this, and it should stay cheap since most users are 'active' with a NULL
-- status_changed_at forever.
--
-- Safe to re-run: IF NOT EXISTS makes this a no-op once the index exists. On
-- failure, check for an INVALID index before retrying — see 001b's header
-- comment and migrate.js's error handler for the exact recovery steps.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_status_changed_at ON users (status_changed_at DESC)
WHERE
    status_changed_at IS NOT NULL
    AND deleted_at IS NULL;
