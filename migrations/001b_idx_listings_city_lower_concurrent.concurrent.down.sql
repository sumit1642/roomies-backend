-- Down for 001b: idx_listings_city_lower
-- Fully reversible — this migration only added an index, no data was
-- transformed. DROP INDEX CONCURRENTLY also cannot run inside a
-- transaction, hence the .concurrent.down.sql naming (matches the up file's
-- .concurrent.sql, so migrate.js's --rollback runs this non-transactionally
-- too).
DROP INDEX CONCURRENTLY IF EXISTS idx_listings_city_lower;
