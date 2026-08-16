-- Migration 002b: idx_connections_interest_request_id, built CONCURRENTLY
--
-- Same story as 001b: fullsql.sql shows this as
--   CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ...
-- but the real applied migration file uses the non-concurrent form because
-- CREATE INDEX CONCURRENTLY cannot run inside migrate.js's transaction
-- wrapper. Split out here so it can run through the non-transactional
-- (.concurrent.sql) path and actually avoid locking `connections` for
-- writes during the build.
--
-- Safe to re-run: IF NOT EXISTS makes this a no-op once the index exists.
-- On failure, check for an INVALID index before retrying — see the header
-- comment in 001b and migrate.js's error handler for the exact steps.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_connections_interest_request_id
    ON connections (interest_request_id)
    WHERE interest_request_id IS NOT NULL
      AND deleted_at IS NULL;
