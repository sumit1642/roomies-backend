-- Migration 012: Enforce uniqueness of city-wide (locality IS NULL) rent_index rows
--
-- PostgreSQL < 15: NULLs are always considered distinct in UNIQUE constraints,
-- so multiple rows with locality IS NULL for the same (city, room_type) are
-- technically allowed. PG 16 (our target) supports UNIQUE NULLS NOT DISTINCT.
--
-- The nightly cron already guards against this with a DELETE before INSERT for
-- city-wide rows, but adding the constraint provides a DB-level guarantee.

ALTER TABLE rent_index
    DROP CONSTRAINT IF EXISTS uq_rent_index;

ALTER TABLE rent_index
    ADD CONSTRAINT uq_rent_index UNIQUE NULLS NOT DISTINCT (city, locality, room_type);