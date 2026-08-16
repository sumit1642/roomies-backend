-- Down for 002b: idx_connections_interest_request_id
-- Fully reversible — index-only change, no data transformation.
DROP INDEX CONCURRENTLY IF EXISTS idx_connections_interest_request_id;
