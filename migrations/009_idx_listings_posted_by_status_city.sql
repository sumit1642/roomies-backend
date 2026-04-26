-- Active: 1777192065763@@127.0.0.1@5432@roomies_db
-- Migration 009: Composite partial index for roommate feed city-filter EXISTS subquery
--
-- The roommate feed's city filter uses an EXISTS subquery on listings:
--   WHERE l.posted_by = sp.user_id AND l.deleted_at IS NULL
--         AND l.status = 'active' AND LOWER(l.city) LIKE LOWER($n) ESCAPE '\'
--
-- The existing idx_listings_posted_by covers posted_by alone but not the
-- full predicate. This index covers the common access pattern.

CREATE INDEX IF NOT EXISTS idx_listings_posted_by_status_city ON listings (posted_by, status, city)
WHERE
    deleted_at IS NULL;