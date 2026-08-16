-- Migration 001b: idx_listings_city_lower, built CONCURRENTLY
--
-- Split out of migration 001. The original migration 001 file has this index
-- commented out to `CREATE INDEX IF NOT EXISTS` (non-concurrent) because
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block, and
-- migrate.js wraps every migration in BEGIN/COMMIT — so it was silently
-- built the locking way instead of the intended concurrent way.
--
-- This file runs via migrate.js's non-transactional path (filename suffix
-- .concurrent.sql) so it can actually use CONCURRENTLY. Safe to re-run:
-- IF NOT EXISTS makes this a no-op once the index exists.
--
-- If this migration fails partway (connection drop, lock conflict), Postgres
-- can leave an INVALID index in the catalog rather than rolling back — see
-- migrate.js's error handler for the exact recovery steps (check
-- pg_index.indisvalid, DROP INDEX CONCURRENTLY it if invalid, then retry
-- this file).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_listings_city_lower
    ON listings (LOWER(city))
    WHERE status = 'active'
      AND deleted_at IS NULL;
