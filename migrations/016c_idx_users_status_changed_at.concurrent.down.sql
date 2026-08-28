-- Down for 016c: idx_users_status_changed_at
-- Fully reversible — index-only change, no data transformation.
DROP INDEX CONCURRENTLY IF EXISTS idx_users_status_changed_at;
