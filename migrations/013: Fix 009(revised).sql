-- Migration 009 (revised): Composite partial index for roommate feed city-filter
--
-- Original index keyed raw city but the query uses LOWER(l.city) LIKE LOWER($n),
-- so the planner couldn't use it. This revision drops the old index and creates
-- an expression index on LOWER(city) so the EXISTS subquery is covered.

DROP INDEX IF EXISTS idx_listings_posted_by_status_city;

CREATE INDEX IF NOT EXISTS idx_listings_posted_by_status_city
ON listings (posted_by, status, LOWER(city))
WHERE deleted_at IS NULL;